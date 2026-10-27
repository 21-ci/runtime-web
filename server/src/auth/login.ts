// First-run setup, password login, second factor and password changes.

import { constantTimeEqual, sha256 } from "../crypto/hash.ts";
import { newId, randomHex } from "../crypto/random.ts";
import { AppError, conflict, forbidden, invalid, notFound } from "../http/errors.ts";
import type { Db } from "../storage/types.ts";
import { recordLogin, type LoginEventIn, type LoginMethod } from "./events.ts";
import { passwordProblem, type Hasher } from "./password.ts";
import { getPolicy } from "./policy.ts";
import {
  accountDelaySeconds,
  accountKey,
  accountNetKey,
  ACCOUNT_WIDE_SOFT_LIMIT,
  globalAttempt,
  IP_FAILURE_LIMIT,
  ipKey,
  isBlocked,
  KNOWN_IP_SECONDS,
  WINDOW_SECONDS,
  knownKey,
  loginKey,
  MAX_LOGIN_FAILURES,
  rateLimited,
  recordFailure,
  resetFailures,
  withHashSlot,
} from "./ratelimit.ts";
import { createSession, lookupSession, revokeAllForUser, revokeSession } from "./session.ts";
import { InvalidCodeError, invalidCredentials, normalizeCode, totpEnabled, useRecoveryCode, validCodeShape, verifyTotpCode } from "./totp.ts";
import { dbOf, getUserByEmail, getUserById, hasherOf, normalizeEmail, userFromRow, type AuthDeps, type SessionUser } from "./types.ts";

export interface Client {
  ip: string;
  ua: string;
}

/** A successful first factor: a full session, or an MFA-pending one (csrf ""). */
export interface LoginOutcome {
  user: SessionUser;
  mfaRequired: boolean;
  cookie: string;
  csrf: string;
}

export async function setupNeeded(db: Db): Promise<boolean> {
  const r = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM users");
  return Number(r?.n ?? 0) === 0;
}

async function setupTokenOk(want: string | undefined, got: unknown): Promise<boolean> {
  if (!want || typeof got !== "string" || got === "") return false;
  return constantTimeEqual(await sha256(got), await sha256(want));
}

export interface SetupIn {
  setup_token?: unknown;
  email?: unknown;
  name?: unknown;
  password?: unknown;
}

/**
 * Creates the first user as instance admin. Order matters: a bad token is always
 * 403 setup_token_invalid (before validation), then 422 invalid, then 409
 * already_set_up. The insert is conditional, so concurrent calls cannot both win.
 */
export async function setup(deps: AuthDeps, body: SetupIn): Promise<SessionUser> {
  if (!(await setupTokenOk(deps.config.setupToken, body.setup_token))) {
    throw forbidden("setup_token_invalid", "setup token missing or wrong");
  }
  const fields: Record<string, string> = {};
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!email) fields.email = "required";
  else if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) fields.email = "invalid_format";
  if (!name) fields.name = "required";
  else if ([...name].length > 200) fields.name = "too_long";
  const pw = passwordProblem(body.password);
  if (pw) fields.password = pw;
  if (Object.keys(fields).length > 0) throw invalid(fields);

  const db = await dbOf(deps);
  if (!(await setupNeeded(db))) throw conflict("already_set_up", "setup is already complete");
  const hash = await hasherOf(deps).hash(body.password as string);
  const now = deps.now();
  const id = newId("usr", now);
  const r = await db.run(
    `INSERT INTO users (id, email, name, pw_hash, must_change, instance_admin, disabled, created_at, updated_at)
     SELECT ?, ?, ?, ?, 0, 1, 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
    [id, email, name, hash, now, now],
  );
  if (r.changes === 0) throw conflict("already_set_up", "setup is already complete");
  return { id, email, name, instanceAdmin: true, mustChangePassword: false, disabled: false, createdAt: now };
}

let dummy: Promise<string> | undefined;
let dummyFor: Hasher | undefined;

/** A real hash of a random value, verified for unknown users so they cost the same as known ones. */
function dummyHash(h: Hasher): Promise<string> {
  if (!dummy || dummyFor !== h) {
    dummyFor = h;
    dummy = h.hash(randomHex(16));
  }
  return dummy;
}

/**
 * Password login. Unknown user, wrong password and disabled user are all 401
 * invalid_credentials. Throttles (see ratelimit.ts): per (ip, email), per IP, a
 * progressive per-account delay for IPs that never signed into the account, a global
 * per-minute cap and an argon2 concurrency cap. When password login is disabled by
 * policy, non-admins get 403 password_login_disabled. Every attempt is recorded.
 */
export async function login(deps: AuthDeps, emailIn: unknown, password: unknown, c: Client): Promise<LoginOutcome> {
  const db = await dbOf(deps);
  const kv = deps.storage.kv;
  const now = deps.now();
  const email = typeof emailIn === "string" ? normalizeEmail(emailIn) : "";
  const pw = typeof password === "string" ? password : "";
  const ev: LoginEventIn = { userId: "", email, ip: c.ip, ua: c.ua, method: "password", result: "ok" };
  const key = await loginKey(c.ip, email);
  const ipK = await ipKey(c.ip);
  const acctK = await accountKey(email);
  const netK = await accountNetKey(c.ip, email);
  const nextK = `${acctK}:next`;
  const netNextK = `${netK}:next`;
  const row = email ? await getUserByEmail(db, email) : null;
  if (row) ev.userId = row.id;
  const known = row ? (await kv.get(await knownKey(c.ip, row.id))) !== null : false;

  const limited = async (retry?: number): Promise<never> => {
    await recordLogin(db, now, { ...ev, result: "rate_limited" });
    throw rateLimited(retry);
  };
  if ((await isBlocked(kv, key, MAX_LOGIN_FAILURES)) || (await isBlocked(kv, ipK, IP_FAILURE_LIMIT))) return limited();
  if (!known) {
    const next = Math.max((await kv.get<number>(nextK)) ?? 0, (await kv.get<number>(netNextK)) ?? 0);
    if (next > now) return limited(Math.ceil((next - now) / 1000));
    try {
      await globalAttempt(kv, now);
    } catch (err) {
      await recordLogin(db, now, { ...ev, result: "rate_limited" });
      throw err;
    }
  }
  const fail = async (result: LoginEventIn["result"]): Promise<never> => {
    await recordFailure(kv, key);
    await recordFailure(kv, ipK);
    const d = accountDelaySeconds(await recordFailure(kv, acctK), ACCOUNT_WIDE_SOFT_LIMIT);
    if (d > 0) await kv.set(nextK, now + d * 1000, { ttlSeconds: WINDOW_SECONDS });
    const dn = accountDelaySeconds(await recordFailure(kv, netK));
    if (dn > 0) await kv.set(netNextK, now + dn * 1000, { ttlSeconds: WINDOW_SECONDS });
    await recordLogin(db, now, { ...ev, result });
    throw invalidCredentials();
  };
  const hasher = hasherOf(deps);
  if (!row || pw.length > 1024) {
    const dh = await dummyHash(hasher);
    await withHashSlot(kv, () => hasher.verify(dh, pw.slice(0, 1024)));
    return fail("bad_password");
  }
  if (!(await withHashSlot(kv, () => hasher.verify(row.pw_hash, pw)))) return fail("bad_password");
  if (Number(row.disabled)) return fail("disabled");
  await resetFailures(kv, key);
  await kv.set(await knownKey(c.ip, row.id), 1, { ttlSeconds: KNOWN_IP_SECONDS });
  if (hasher.needsRehash?.(row.pw_hash)) {
    const fresh = await hasher.hash(pw);
    await db.run("UPDATE users SET pw_hash = ? WHERE id = ? AND pw_hash = ?", [fresh, row.id, row.pw_hash]);
  }
  if (!Number(row.instance_admin) && (await getPolicy(db)).passwordLoginDisabled) {
    await recordLogin(db, now, { ...ev, result: "sso_only" });
    throw forbidden("password_login_disabled", "password login is disabled; use single sign-on");
  }
  return begin(deps, db, userFromRow(row), ev);
}

/** Starts a session for a user authenticated another way (OAuth, invite). Disabled → 401 invalid_credentials. */
export async function loginUser(deps: AuthDeps, userId: string, method: LoginMethod, c: Client): Promise<LoginOutcome> {
  const db = await dbOf(deps);
  const row = await getUserById(db, userId);
  if (!row) throw invalidCredentials();
  const ev: LoginEventIn = { userId: row.id, email: row.email, ip: c.ip, ua: c.ua, method, result: "ok" };
  if (Number(row.disabled)) {
    await recordLogin(db, deps.now(), { ...ev, result: "disabled" });
    throw invalidCredentials();
  }
  return begin(deps, db, userFromRow(row), ev);
}

async function begin(deps: AuthDeps, db: Db, user: SessionUser, ev: LoginEventIn): Promise<LoginOutcome> {
  const mfa = await totpEnabled(db, user.id);
  const now = deps.now();
  await recordLogin(db, now, { ...ev, result: mfa ? "mfa_pending" : "ok" });
  const s = await createSession(db, now, user.id, ev.ip, ev.ua, mfa);
  return { user, mfaRequired: mfa, cookie: s.cookie, csrf: s.csrf };
}

/** 401 at /api/auth/mfa: the code is the second factor. */
export const invalidCodeAuth = () => new AppError(401, "invalid_code", "invalid code");
const noSession = () => new AppError(401, "unauthenticated", "sign in required");

/**
 * Swaps an MFA-pending session for a full one given a TOTP or recovery code.
 * Only the caller that deletes the pending row gets a session.
 */
export async function completeMfa(deps: AuthDeps, pendingCookie: string | undefined, code: unknown): Promise<LoginOutcome> {
  const db = await dbOf(deps);
  const found = pendingCookie ? await lookupSession(db, deps.now(), pendingCookie, true) : null;
  if (!found) throw noSession();
  const { session, user } = found;
  const ev: LoginEventIn = { userId: user.id, email: user.email, ip: session.ip, ua: session.ua, method: "password", result: "ok" };
  const c = typeof code === "string" ? code : "";
  try {
    if (validCodeShape(normalizeCode(c))) await verifyTotpCode(deps, user.id, c);
    else await useRecoveryCode(deps, user.id, c);
  } catch (err) {
    if (err instanceof InvalidCodeError) {
      await recordLogin(db, deps.now(), { ...ev, result: "bad_totp" });
      throw invalidCodeAuth();
    }
    if (err instanceof AppError && err.status === 429) await recordLogin(db, deps.now(), { ...ev, result: "rate_limited" });
    throw err;
  }
  if (!(await revokeSession(db, session.id))) throw noSession();
  const now = deps.now();
  await recordLogin(db, now, ev);
  const s = await createSession(db, now, user.id, session.ip, session.ua);
  return { user, mfaRequired: false, cookie: s.cookie, csrf: s.csrf };
}

async function setPassword(deps: AuthDeps, db: Db, userId: string, pw: string, mustChange: boolean): Promise<void> {
  const hash = await hasherOf(deps).hash(pw);
  const r = await db.run("UPDATE users SET pw_hash = ?, must_change = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [
    hash,
    mustChange ? 1 : 0,
    deps.now(),
    userId,
  ]);
  if (r.changes === 0) throw notFound();
}

/** Checks the current password, sets the new one and revokes the user's other sessions. */
export async function changePassword(deps: AuthDeps, userId: string, currentSessionId: string, current: unknown, next: unknown): Promise<void> {
  const db = await dbOf(deps);
  const row = await getUserById(db, userId);
  if (!row) throw notFound();
  const problem = passwordProblem(next);
  // A stolen session must not become an unthrottled oracle for the password (or an argon2 DoS).
  const kv = deps.storage.kv;
  const failKey = `rl:pwchange:${userId}`;
  if (await isBlocked(kv, failKey, MAX_LOGIN_FAILURES)) throw rateLimited();
  const ok =
    typeof current === "string" && current.length <= 1024 && (await withHashSlot(kv, () => hasherOf(deps).verify(row.pw_hash, current)));
  if (!ok) {
    await recordFailure(kv, failKey);
    throw invalidCredentials();
  }
  await resetFailures(kv, failKey);
  if (problem) throw invalid({ new_password: problem });
  await setPassword(deps, db, userId, next as string, false);
  await revokeAllForUser(db, userId, currentSessionId);
}

/** Admin reset: sets a temporary password the user must change and revokes all sessions. 422 if it fails the policy. */
export async function resetPassword(deps: AuthDeps, userId: string, temp: string): Promise<void> {
  const problem = passwordProblem(temp);
  if (problem) throw invalid({ password: problem });
  const db = await dbOf(deps);
  await setPassword(deps, db, userId, temp, true);
  await revokeAllForUser(db, userId);
}

/** Disables or enables a user; disabling revokes all sessions. */
export async function setDisabled(deps: AuthDeps, userId: string, disabled: boolean): Promise<void> {
  const db = await dbOf(deps);
  const r = await db.run("UPDATE users SET disabled = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [
    disabled ? 1 : 0,
    deps.now(),
    userId,
  ]);
  if (r.changes === 0) throw notFound();
  if (disabled) await revokeAllForUser(db, userId);
}
