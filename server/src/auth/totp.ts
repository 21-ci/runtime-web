// TOTP second factor and recovery codes. Secrets (20 bytes) are sealed at rest; `last_step` rejects
// replays; recovery codes are stored as sha256(normalized) hex. Failures share
// the per-user `lockout:<user>` budget (5 / 15 min).

import { constantTimeEqual, sha256Hex } from "../crypto/hash.ts";
import { randomBytes } from "../crypto/random.ts";
import { base32Encode, hotp, otpauthUri, TOTP_PERIOD_SECONDS, TOTP_SKEW } from "../crypto/totp.ts";
import { AppError, conflict, notFound } from "../http/errors.ts";
import type { Db, Stmt } from "../storage/types.ts";
import { isBlocked, lockoutKey, MAX_TOTP_FAILURES, rateLimited, recordFailure, resetFailures } from "./ratelimit.ts";
import { dbOf, getUserById, hasherOf, sealerOf, type AuthDeps } from "./types.ts";

export const RECOVERY_CODE_COUNT = 10;
export const TOTP_ISSUER = "Runtime Web";

/** Internal marker for a wrong, malformed, replayed or used code; routes map it to 401 or 422. */
export class InvalidCodeError extends Error {
  constructor() {
    super("invalid code");
    this.name = "InvalidCodeError";
  }
}

export const invalidCredentials = () => new AppError(401, "invalid_credentials", "invalid email or password");

/** Strips spaces and dashes, lower-cases. */
export function normalizeCode(code: string): string {
  return code.trim().toLowerCase().replace(/[ -]/g, "");
}

export const validCodeShape = (code: string) => /^[0-9]{6}$/.test(code);

interface TotpRow {
  secret_sealed: Uint8Array;
  enabled_at: number | null;
  last_step: number;
  [k: string]: unknown;
}

async function totpRow(db: Db, userId: string): Promise<TotpRow | null> {
  return db.first<TotpRow>("SELECT secret_sealed, enabled_at, last_step FROM user_totp WHERE user_id = ?", [userId]);
}

/** Whether userId has a confirmed TOTP. */
export async function totpEnabled(db: Db, userId: string): Promise<boolean> {
  const r = await totpRow(db, userId);
  return r !== null && r.enabled_at !== null;
}

/** Starts (or restarts) an unconfirmed enrollment and returns the otpauth URL. */
export async function enroll(deps: AuthDeps, userId: string): Promise<string> {
  const db = await dbOf(deps);
  const u = await getUserById(db, userId);
  if (!u) throw notFound();
  if (await totpEnabled(db, userId)) throw conflict("totp_already_enabled", "two-factor authentication is already on");
  const secret = randomBytes(20);
  const sealed = await (await sealerOf(deps)).seal(secret);
  await db.batch([
    { sql: "DELETE FROM user_totp WHERE user_id = ? AND enabled_at IS NULL", args: [userId] },
    { sql: "INSERT INTO user_totp (user_id, secret_sealed, enabled_at, last_step) VALUES (?, ?, NULL, -1)", args: [userId, sealed] },
  ]);
  return otpauthUri(TOTP_ISSUER, u.email, secret);
}

async function blocked(deps: AuthDeps, userId: string): Promise<void> {
  if (await isBlocked(deps.storage.kv, lockoutKey(userId), MAX_TOTP_FAILURES)) throw rateLimited();
}

async function fail(deps: AuthDeps, userId: string): Promise<never> {
  await recordFailure(deps.storage.kv, lockoutKey(userId));
  throw new InvalidCodeError();
}

/** Checks a TOTP code against the confirmed (enabled) or pending enrollment. Throws InvalidCodeError / 429. */
async function check(deps: AuthDeps, userId: string, code: string, enabled: boolean): Promise<void> {
  await blocked(deps, userId);
  const db = await dbOf(deps);
  const row = await totpRow(db, userId);
  if (!row || (row.enabled_at !== null) !== enabled) return fail(deps, userId);
  const c = normalizeCode(code);
  if (!validCodeShape(c)) return fail(deps, userId);
  const secret = await (await sealerOf(deps)).open(new Uint8Array(row.secret_sealed));
  const step = Math.floor(deps.now() / 1000 / TOTP_PERIOD_SECONDS);
  let matched = -1;
  for (let d = -TOTP_SKEW; d <= TOTP_SKEW; d++) {
    if (step + d < 0) continue;
    if (constantTimeEqual(await hotp(secret, step + d), c)) matched = step + d;
  }
  if (matched < 0) return fail(deps, userId);
  // Advancing only to a newer step rejects replays atomically.
  const r = await db.run("UPDATE user_totp SET last_step = ? WHERE user_id = ? AND last_step < ?", [matched, userId, matched]);
  if (r.changes === 0) return fail(deps, userId);
  await resetFailures(deps.storage.kv, lockoutKey(userId));
}

/** Verifies a code for a user with confirmed TOTP. */
export const verifyTotpCode = (deps: AuthDeps, userId: string, code: string) => check(deps, userId, code, true);

/** Consumes one recovery code of a user with confirmed TOTP. */
export async function useRecoveryCode(deps: AuthDeps, userId: string, code: string): Promise<void> {
  await blocked(deps, userId);
  const db = await dbOf(deps);
  const norm = normalizeCode(code);
  if (!norm || !(await totpEnabled(db, userId))) return fail(deps, userId);
  const r = await db.run(
    "UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
    [deps.now(), userId, await sha256Hex(norm)],
  );
  if (r.changes === 0) return fail(deps, userId);
  await resetFailures(deps.storage.kv, lockoutKey(userId));
}

/** An 80-bit code shaped xxxx-xxxx-xxxx-xxxx (lower-case base32), as Go. */
export function newRecoveryCode(): string {
  const s = base32Encode(randomBytes(10)).toLowerCase();
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}

/** New plaintext codes plus the statements that replace userId's stored hashes. */
async function recoveryStatements(userId: string): Promise<{ codes: string[]; stmts: Stmt[] }> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const stmts: Stmt[] = [{ sql: "DELETE FROM recovery_codes WHERE user_id = ?", args: [userId] }];
  for (const c of codes) {
    stmts.push({
      sql: "INSERT INTO recovery_codes (user_id, code_hash, used_at) VALUES (?, ?, NULL)",
      args: [userId, await sha256Hex(normalizeCode(c))],
    });
  }
  return { codes, stmts };
}

/** Activates a pending enrollment with a valid code and returns the recovery codes (shown once). */
export async function confirm(deps: AuthDeps, userId: string, code: string): Promise<string[]> {
  const db = await dbOf(deps);
  if (await totpEnabled(db, userId)) throw conflict("totp_already_enabled", "two-factor authentication is already on");
  await check(deps, userId, code, false);
  const { codes, stmts } = await recoveryStatements(userId);
  await db.batch([
    { sql: "UPDATE user_totp SET enabled_at = ? WHERE user_id = ? AND enabled_at IS NULL", args: [deps.now(), userId] },
    ...stmts,
  ]);
  return codes;
}

/** Re-checks the password for sensitive changes; failures count toward the lockout. */
async function checkPassword(deps: AuthDeps, userId: string, password: string): Promise<void> {
  await blocked(deps, userId);
  const db = await dbOf(deps);
  const u = await getUserById(db, userId);
  if (!u) throw notFound();
  if (typeof password !== "string" || !(await hasherOf(deps).verify(u.pw_hash, password))) {
    await recordFailure(deps.storage.kv, lockoutKey(userId));
    throw invalidCredentials();
  }
}

/** Statements that delete userId's TOTP and recovery codes. */
export const clear2faStatements = (userId: string): Stmt[] => [
  { sql: "DELETE FROM recovery_codes WHERE user_id = ?", args: [userId] },
  { sql: "DELETE FROM user_totp WHERE user_id = ?", args: [userId] },
];

/** Removes TOTP (needs password and a current code) and revokes the other sessions. */
export async function disable(deps: AuthDeps, userId: string, currentSessionId: string, password: string, code: string): Promise<void> {
  const db = await dbOf(deps);
  if (!(await totpEnabled(db, userId))) throw conflict("totp_not_enabled", "two-factor authentication is off");
  await checkPassword(deps, userId, password);
  await verifyTotpCode(deps, userId, code);
  await db.batch([
    ...clear2faStatements(userId),
    { sql: "DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?", args: [userId, currentSessionId] },
  ]);
}

/** Replaces every recovery code (needs the password). */
export async function regenerateRecoveryCodes(deps: AuthDeps, userId: string, password: string): Promise<string[]> {
  await checkPassword(deps, userId, password);
  const db = await dbOf(deps);
  if (!(await totpEnabled(db, userId))) throw conflict("totp_not_enabled", "two-factor authentication is off");
  const { codes, stmts } = await recoveryStatements(userId);
  await db.batch(stmts);
  return codes;
}
