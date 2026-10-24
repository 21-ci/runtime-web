// Failure counters in std:kv (port of internal/auth/ratelimit.go, which used a
// SQL table). Fixed windows: the first failure creates the counter with a TTL,
// so the budget resets at most LOGIN_WINDOW after it was first spent.
//
// Keys: `rl:login:<sha256(ip|email)>` for password logins (10 / 15 min) and
// `lockout:<user>` for second factors and password re-checks (5 / 15 min).

import { sha256Hex } from "../crypto/hash.ts";
import { AppError } from "../http/errors.ts";
import type { Kv } from "../storage/types.ts";

export const MAX_LOGIN_FAILURES = 10;
export const MAX_TOTP_FAILURES = 5;
export const WINDOW_SECONDS = 15 * 60;

export const loginKey = async (ip: string, email: string) => `rl:login:${await sha256Hex(`${ip}|${email}`)}`;
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
