// Instance-admin user management: create with a temporary
// password, list (paged), update (name/disabled/admin), soft delete, reset password/2FA.

import type { Deps } from "../app.ts";
import { clear2faStatements } from "../auth/totp.ts";
import { dbOf, hasherOf, normalizeEmail, userFromRow, userJson, type UserJson, type UserRow } from "../auth/types.ts";
import { base32Encode } from "../crypto/totp.ts";
import { newId, randomBytes } from "../crypto/random.ts";
import { conflict, invalid, notFound } from "../http/errors.ts";
import type { Stmt, Tx } from "../storage/types.ts";
import type { Actor } from "../orgs/common.ts";
import { auditStmt } from "../audit/audit.ts";

export type UserDeps = Pick<Deps, "storage" | "now" | "hasher">;

export const TEMP_PASSWORD_LEN = 20;
const MAX_NAME = 200;

/** TEMP_PASSWORD_LEN random base32 characters. */
export function tempPassword(): string {
  return base32Encode(randomBytes(TEMP_PASSWORD_LEN)).replace(/=+$/, "").slice(0, TEMP_PASSWORD_LEN);
}

async function exec(q: Tx, stmts: Stmt[]): Promise<void> {
  for (const s of stmts) await q.run(s.sql, s.args);
}

async function toJson(q: Tx, r: UserRow): Promise<UserJson> {
  const [t] = await q.all("SELECT 1 FROM user_totp WHERE user_id = ? AND enabled_at IS NOT NULL", [r.id]);
  return userJson(userFromRow(r), !!t);
}

async function getRow(q: Tx, id: string): Promise<UserRow> {
  const [u] = await q.all<UserRow>("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL", [id]);
  if (!u) throw notFound();
  return u;
}

/** Refuses a change that would leave no enabled instance admin (409 last_admin). */
async function guardLastAdmin(q: Tx): Promise<void> {
  const [r] = await q.all<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE instance_admin = 1 AND disabled = 0 AND deleted_at IS NULL");
  if (Number(r?.n ?? 0) <= 1) throw conflict("last_admin", "at least one enabled instance admin is required");
}

/** Refuses deleting the only owner of any org (409 last_owner). */
async function guardSoleOwner(q: Tx, userId: string): Promise<void> {
  const rows = await q.all<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM members o WHERE o.org_id = m.org_id AND o.role = 'owner') AS n
     FROM members m WHERE m.user_id = ? AND m.role = 'owner'`,
    [userId],
  );
  if (rows.some((r) => Number(r.n) <= 1)) throw conflict("last_owner", "user is the only owner of an org");
}

export async function createUser(deps: UserDeps, actor: Actor, body: Record<string, unknown>): Promise<{ user: UserJson; tempPassword: string }> {
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const fields: Record<string, string> = {};
  if (!email) fields.email = "required";
  else if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) fields.email = "invalid_format";
  if (!name) fields.name = "required";
  else if ([...name].length > MAX_NAME) fields.name = "too_long";
  if (body.instance_admin !== undefined && typeof body.instance_admin !== "boolean") fields.instance_admin = "invalid";
  if (Object.keys(fields).length) throw invalid(fields);
  const admin = body.instance_admin === true;
  const temp = tempPassword();
  const hash = await hasherOf(deps).hash(temp);
  const db = await dbOf(deps);
  return db.tx(async (q) => {
    const [dup] = await q.all("SELECT 1 FROM users WHERE email = ?", [email]);
    if (dup) throw conflict("email_taken", "email is already in use");
    const now = deps.now();
    const id = newId("usr_", now);
    await q.run(
      "INSERT INTO users (id, email, name, pw_hash, must_change, instance_admin, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, 0, ?, ?)",
      [id, email, name, hash, admin ? 1 : 0, now, now],
    );
    await exec(q, [auditStmt(now, { actor, orgId: null, action: "user.create", target: id, detail: { email, admin } })]);
    return { user: await toJson(q, await getRow(q, id)), tempPassword: temp };
  });
}

const enc = (s: string) => btoa(s).replace(/=+$/, "");
const dec = (s: string) => {
  try {
    return atob(s);
  } catch {
    return null;
  }
};

/** Page<User> ordered by id; q filters on email/name (substring, case-insensitive). */
export async function listUsers(deps: Pick<Deps, "storage">, opts: { cursor?: string | null; limit?: string | null; q?: string | null }): Promise<{ items: UserJson[]; next_cursor: string | null }> {
  let limit = opts.limit ? Number(opts.limit) : 50;
  if (!Number.isInteger(limit) || limit < 1) throw invalid({ limit: "invalid" });
  limit = Math.min(limit, 200);
  const after = opts.cursor ? dec(opts.cursor) : "";
  if (after === null) throw invalid({ cursor: "invalid" });
  const db = await dbOf(deps);
  const args: (string | number)[] = [after];
  let where = "deleted_at IS NULL AND id > ?";
  if (opts.q) {
    const like = `%${opts.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where += " AND (lower(email) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\')";
    args.push(like, like);
  }
  args.push(limit + 1);
  const rows = await db.all<UserRow>(`SELECT * FROM users WHERE ${where} ORDER BY id LIMIT ?`, args);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const items = await Promise.all(page.map((r) => toJson(db, r)));
  return { items, next_cursor: more ? enc((page.at(-1) as UserRow).id) : null };
}

/** PATCH {name?, disabled?, instance_admin?}. Disabling revokes sessions; the last enabled admin is kept. */
export async function updateUser(deps: UserDeps, actor: Actor, id: string, body: Record<string, unknown>): Promise<UserJson> {
  const fields: Record<string, string> = {};
  let name: string | undefined;
  if (body.name !== undefined) {
    name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) fields.name = "required";
    else if ([...name].length > MAX_NAME) fields.name = "too_long";
  }
  for (const k of ["disabled", "instance_admin"] as const) {
    if (body[k] !== undefined && typeof body[k] !== "boolean") fields[k] = "invalid";
  }
  if (Object.keys(fields).length) throw invalid(fields);
  const db = await dbOf(deps);
  return db.tx(async (q) => {
    const u = await getRow(q, id);
    const disabled = typeof body.disabled === "boolean" ? body.disabled : Number(u.disabled) !== 0;
    const admin = typeof body.instance_admin === "boolean" ? body.instance_admin : Number(u.instance_admin) !== 0;
    const wasEnabledAdmin = Number(u.instance_admin) !== 0 && Number(u.disabled) === 0;
    if (wasEnabledAdmin && !(admin && !disabled)) await guardLastAdmin(q);
    const now = deps.now();
    await q.run("UPDATE users SET name = ?, disabled = ?, instance_admin = ?, updated_at = ? WHERE id = ?", [
      name ?? u.name,
      disabled ? 1 : 0,
      admin ? 1 : 0,
      now,
      id,
    ]);
    if (disabled) await q.run("DELETE FROM sessions WHERE user_id = ?", [id]);
    const detail: Record<string, unknown> = {};
    if (name !== undefined) detail.name = name;
    if (typeof body.disabled === "boolean") detail.disabled = disabled;
    if (typeof body.instance_admin === "boolean") detail.instance_admin = admin;
    await exec(q, [auditStmt(now, { actor, orgId: null, action: "user.update", target: id, detail })]);
    return toJson(q, await getRow(q, id));
  });
}

/**
 * Soft delete: the row stays for references, email/name are anonymised, password, 2FA,
 * sessions, identities, memberships and grants go. Last admin / sole owner are refused.
 */
export async function deleteUser(deps: UserDeps, actor: Actor, id: string): Promise<void> {
  const db = await dbOf(deps);
  await db.tx(async (q) => {
    const u = await getRow(q, id);
    if (Number(u.instance_admin) !== 0 && Number(u.disabled) === 0) await guardLastAdmin(q);
    await guardSoleOwner(q, id);
    const now = deps.now();
    await exec(q, [
      { sql: "DELETE FROM members WHERE user_id = ?", args: [id] },
      { sql: "DELETE FROM project_grants WHERE user_id = ?", args: [id] },
      ...clear2faStatements(id),
      { sql: "DELETE FROM identities WHERE user_id = ?", args: [id] },
      { sql: "DELETE FROM sessions WHERE user_id = ?", args: [id] },
      {
        sql: "UPDATE users SET email = ?, name = 'Deleted user', pw_hash = '', instance_admin = 0, disabled = 1, updated_at = ?, deleted_at = ? WHERE id = ?",
        args: [`deleted-${id}@invalid`, now, now, id],
      },
      auditStmt(now, { actor, orgId: null, action: "user.delete", target: id }),
    ]);
  });
}

/** New temporary password (must change at next login); all sessions revoked. */
export async function resetUserPassword(deps: UserDeps, actor: Actor, id: string): Promise<string> {
  const temp = tempPassword();
  const hash = await hasherOf(deps).hash(temp);
  const db = await dbOf(deps);
  await db.tx(async (q) => {
    await getRow(q, id);
    const now = deps.now();
    await exec(q, [
      { sql: "UPDATE users SET pw_hash = ?, must_change = 1, updated_at = ? WHERE id = ?", args: [hash, now, id] },
      { sql: "DELETE FROM sessions WHERE user_id = ?", args: [id] },
      auditStmt(now, { actor, orgId: null, action: "user.reset_password", target: id }),
    ]);
  });
  return temp;
}

/** Removes 2FA enrolment and recovery codes; all sessions revoked. */
export async function resetUserTotp(deps: UserDeps, actor: Actor, id: string): Promise<void> {
  const db = await dbOf(deps);
  await db.tx(async (q) => {
    await getRow(q, id);
    await exec(q, [
      ...clear2faStatements(id),
      { sql: "DELETE FROM sessions WHERE user_id = ?", args: [id] },
      auditStmt(deps.now(), { actor, orgId: null, action: "user.reset_totp", target: id }),
    ]);
  });
}
