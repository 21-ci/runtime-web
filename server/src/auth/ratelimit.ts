// Failure counters and throttles in std:kv. Fixed windows: the first increment creates
// the counter with a TTL, so a budget resets at most its window after it was first spent.
//
// The client address is only ever the runtime-resolved one (ctx.client.ip, which equals
// x-rt-client-ip; the runtime strips client-sent x-rt-* headers). X-Forwarded-For is never read.
//
// Password login design (audit H2):
//   - `rl:login:<sha256(ip|email)>`: 10 failures / 15 min → hard 429. Only hurts that IP.
//   - `rl:ip:<sha256(ip)>`: 30 failures / 15 min for any email → 429 (stops spraying from one host).
//   - `rl:acctnet:<sha256(prefix|email)>`: failures on the account from one network (IPv4 /24,
//     IPv6 /64). Past 10, an IP of that network that has never signed into this account gets a
//     progressive delay (2^(n-11) s, max 60 s) instead of a lock.
//   - `rl:acct:<sha256(email)>`: failures across all networks. The same delay starts only past
//     50, so one network spraying an account slows itself down, not the owner elsewhere, while a
//     distributed guess is still slowed.
//   - `rl:known:<sha256(ip|user)>`: set for 30 days after a correct password from that IP; such
//     IPs skip the account delay and the global cap.
//   - `rl:global:<minute>`: 60 unauthenticated login attempts per minute instance-wide.
//   - `argon2:inflight`: at most MAX_INFLIGHT_HASHES concurrent unauthenticated argon2 runs (M6),
//     503 busy beyond that (the guest has 128 MB).
// `lockout:<user>` covers second factors and password re-checks: 5 free failures, then a
// progressive delay (30 s doubling to 15 min, `lockout:<user>:next`) rather than a hard block, so a
// stolen password cannot shut the owner out of MFA for long. The counter lives 24 h and a success
// resets it.

import { sha256Hex } from "../crypto/hash.ts";
import { AppError } from "../http/errors.ts";
import type { Kv } from "../storage/types.ts";

export const MAX_LOGIN_FAILURES = 10;
export const MAX_TOTP_FAILURES = 5;
export const WINDOW_SECONDS = 15 * 60;
export const IP_FAILURE_LIMIT = 30;
export const ACCOUNT_SOFT_LIMIT = 10;
export const ACCOUNT_WIDE_SOFT_LIMIT = 50;
export const ACCOUNT_MAX_DELAY_SECONDS = 60;
export const MFA_BASE_DELAY_SECONDS = 30;
export const MFA_MAX_DELAY_SECONDS = 15 * 60;
export const MFA_WINDOW_SECONDS = 24 * 3600;
export const GLOBAL_LOGINS_PER_MINUTE = 60;
export const MAX_INFLIGHT_HASHES = 2;
export const KNOWN_IP_SECONDS = 30 * 24 * 3600;

export const loginKey = async (ip: string, email: string) => `rl:login:${await sha256Hex(`${ip}|${email}`)}`;
export const ipKey = async (ip: string) => `rl:ip:${await sha256Hex(ip)}`;
export const accountKey = async (email: string) => `rl:acct:${await sha256Hex(email)}`;
export const accountNetKey = async (ip: string, email: string) => `rl:acctnet:${await sha256Hex(`${netPrefix(ip)}|${email}`)}`;
export const knownKey = async (ip: string, userId: string) => `rl:known:${await sha256Hex(`${ip}|${userId}`)}`;
export const lockoutKey = (userId: string) => `lockout:${userId}`;

export async function isBlocked(kv: Kv, key: string, max: number): Promise<boolean> {
  const n = await kv.get<number>(key);
  return typeof n === "number" && n >= max;
}

export async function recordFailure(kv: Kv, key: string): Promise<number> {
  return kv.incr(key, 1, { ttlSeconds: WINDOW_SECONDS });
}

export async function resetFailures(kv: Kv, key: string): Promise<void> {
  await kv.delete(key);
}

/** 429 rate_limited with details.retry_after; withRetryAfter adds the header. */
export function rateLimited(retryAfter = WINDOW_SECONDS): AppError {
  return new AppError(429, "rate_limited", "too many attempts, try again later", { retry_after: retryAfter });
}

const busy = () => new AppError(503, "busy", "server busy, try again", { retry_after: 1 });

/** Delay before the next unknown-IP attempt after `n` failures past `soft` (0 = none). */
export function accountDelaySeconds(n: number, soft = ACCOUNT_SOFT_LIMIT): number {
  if (n <= soft) return 0;
  return Math.min(2 ** (n - soft - 1), ACCOUNT_MAX_DELAY_SECONDS);
}

/** The network an address belongs to: IPv4 /24 or IPv6 /64; anything else is its own network. */
export function netPrefix(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().replace(/^\[|\]$/g, "").split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":")}::/64`;
}

/** Seconds to wait after `n` second-factor failures (0 for the first MAX_TOTP_FAILURES - 1). */
export function mfaDelaySeconds(n: number): number {
  if (n < MAX_TOTP_FAILURES) return 0;
  return Math.min(MFA_BASE_DELAY_SECONDS * 2 ** (n - MAX_TOTP_FAILURES), MFA_MAX_DELAY_SECONDS);
}

/** 429 when the user's second-factor backoff has not elapsed. */
export async function mfaBlocked(kv: Kv, userId: string, now: number): Promise<void> {
  const next = await kv.get<number>(`${lockoutKey(userId)}:next`);
  if (typeof next === "number" && next > now) throw rateLimited(Math.ceil((next - now) / 1000));
}

/** Counts a second-factor or password re-check failure and arms the backoff. */
export async function mfaFailure(kv: Kv, userId: string, now: number): Promise<void> {
  const n = await kv.incr(lockoutKey(userId), 1, { ttlSeconds: MFA_WINDOW_SECONDS });
  const d = mfaDelaySeconds(n);
  if (d > 0) await kv.set(`${lockoutKey(userId)}:next`, now + d * 1000, { ttlSeconds: d });
}

/** Clears the user's second-factor failures after a success. */
export async function mfaReset(kv: Kv, userId: string): Promise<void> {
  await kv.delete(lockoutKey(userId));
  await kv.delete(`${lockoutKey(userId)}:next`);
}

/** Counts one attempt against the instance-wide per-minute cap; 429 beyond it. */
export async function globalAttempt(kv: Kv, now: number, prefix = "rl:global"): Promise<void> {
  const minute = Math.floor(now / 60_000);
  const n = await kv.incr(`${prefix}:${minute}`, 1, { ttlSeconds: 120 });
  if (n > GLOBAL_LOGINS_PER_MINUTE) throw rateLimited(Math.max(1, Math.ceil(((minute + 1) * 60_000 - now) / 1000)));
}

/**
 * Runs fn holding one of MAX_INFLIGHT_HASHES instance-wide argon2 slots; 503 busy when
 * none is free. The counter has a TTL so a crashed holder cannot leak a slot forever.
 */
export async function withHashSlot<T>(kv: Kv, fn: () => Promise<T>): Promise<T> {
  const key = "argon2:inflight";
  const n = await kv.incr(key, 1, { ttlSeconds: 30 });
  if (n > MAX_INFLIGHT_HASHES) {
    await kv.incr(key, -1, { ttlSeconds: 30 });
    throw busy();
  }
  try {
    return await fn();
  } finally {
    await kv.incr(key, -1, { ttlSeconds: 30 });
  }
}
