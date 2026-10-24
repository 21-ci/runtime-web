// Expiring, single-use invite links (port of internal/invites). Tokens are stored as
// SHA-256 hex. A new email creates the user with the chosen password and logs in via
// loginUser (2FA policy applies); an existing account must be the caller and only gets
// the bound membership. Revoking deletes the row (unknown == revoked to the public).

import type { Deps } from "../app.ts";
import { passwordProblem } from "../auth/password.ts";
import { dbOf, hasherOf, normalizeEmail } from "../auth/types.ts";
import { ORG_ROLES, can, type Subject } from "../authz/policy.ts";
import { sha256Hex } from "../crypto/hash.ts";
import { newId, randomToken } from "../crypto/random.ts";
import { AppError, forbidden, invalid, notFound } from "../http/errors.ts";
import type { Tx } from "../storage/types.ts";
import { auditStmt, type Actor } from "../orgs/common.ts";

export type InviteDeps = Pick<Deps, "storage" | "now" | "config" | "hasher">;

export const INVITE_TTL_MS = 7 * 24 * 3600_000;
const DEFAULT_ROLE = "member";

export interface InviteJson {
  id: string;
  email: string;
  org: { slug: string; name: string } | null;
  role: string | null;
  created_by: { id: string; name: string };
  created_at: number;
  expires_at: number;
}

export const inviteInvalid = () => new AppError(404, "invite_invalid", "invite is invalid or expired");

interface Row {
  id: string;
  email: string;
  org_id: string | null;
  role: string | null;
  created_by: string;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  org_slug: string | null;
  org_name: string | null;
  creator_name: string | null;
  [k: string]: unknown;
}

const SELECT = `SELECT i.id, i.email, i.org_id, i.role, i.created_by, i.created_at, i.expires_at, i.accepted_at,
  o.slug AS org_slug, o.name AS org_name, u.name AS creator_name
  FROM invites i LEFT JOIN orgs o ON o.id = i.org_id LEFT JOIN users u ON u.id = i.created_by`;

const toJson = (r: Row): InviteJson => ({
  id: r.id,
  email: r.email,
  org: r.org_id ? { slug: r.org_slug ?? "", name: r.org_name ?? "" } : null,
  role: r.org_id ? (r.role ?? DEFAULT_ROLE) : null,
  created_by: { id: r.created_by, name: r.creator_name ?? "" },
  created_at: Number(r.created_at),
  expires_at: Number(r.expires_at),
});

const pending = (r: Row, now: number) => r.accepted_at === null && now < Number(r.expires_at);

/**
 * Issues an invite. orgId null = unbound (instance admin only, no role). For an org the
 * caller (subject resolved in that org) needs invites.manage, plus members.owners for owner.
 */
export async function createInvite(
  deps: InviteDeps,
  actor: Actor,
  subject: Subject,
  orgId: string | null,
  body: Record<string, unknown>,
): Promise<{ invite: InviteJson; link: string }> {
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const fields: Record<string, string> = {};
  if (!email) fields.email = "required";
  else if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) fields.email = "invalid_format";
  const role = body.role === undefined || body.role === null ? undefined : body.role;
  if (role !== undefined && (typeof role !== "string" || !(ORG_ROLES as readonly string[]).includes(role))) fields.role = "invalid";
  if (orgId === null && role !== undefined) fields.role = "needs_org";
  if (Object.keys(fields).length) throw invalid(fields);
  const r = orgId ? ((role as string | undefined) ?? DEFAULT_ROLE) : null;
  authorize(subject, orgId, r);

  const token = randomToken(32);
  const now = deps.now();
  const id = newId("inv_", now);
  const db = await dbOf(deps);
  await db.batch([
    {
      sql: "INSERT INTO invites (id, token_hash, org_id, email, role, instance_admin, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)",
      args: [id, await sha256Hex(token), orgId, email, r, actor.userId, now, now + INVITE_TTL_MS],
    },
    auditStmt(now, actor, orgId, "invite.create", id, { email, role: r }),
  ]);
  const row = await db.first<Row>(`${SELECT} WHERE i.id = ?`, [id]);
  return { invite: toJson(row as Row), link: `${deps.config.origin}/invite/${token}` };
}

function authorize(sub: Subject, orgId: string | null, role: string | null): void {
  const s = orgId ? sub : { userId: sub.userId, instanceAdmin: sub.instanceAdmin === true };
  if (!can(s, "invites.manage")) throw forbidden();
  if (role === "owner" && !can(s, "members.owners")) throw forbidden();
}

/** Pending invites; orgId null = all orgs (optionally filtered by org slug) plus unbound. */
export async function listInvites(deps: Pick<Deps, "storage" | "now">, orgId: string | null, orgSlug?: string | null): Promise<InviteJson[]> {
  const db = await dbOf(deps);
  const now = deps.now();
  let rows: Row[];
  if (orgId) rows = await db.all<Row>(`${SELECT} WHERE i.org_id = ? AND i.accepted_at IS NULL AND i.expires_at > ? ORDER BY i.created_at, i.id`, [orgId, now]);
  else if (orgSlug) rows = await db.all<Row>(`${SELECT} WHERE o.slug = ? AND i.accepted_at IS NULL AND i.expires_at > ? ORDER BY i.created_at, i.id`, [orgSlug, now]);
  else rows = await db.all<Row>(`${SELECT} WHERE i.accepted_at IS NULL AND i.expires_at > ? ORDER BY i.created_at, i.id`, [now]);
  return rows.map(toJson);
}

/** Revokes a pending invite. orgId set: the invite must belong to it (else 404). */
export async function revokeInvite(deps: Pick<Deps, "storage" | "now">, actor: Actor, subject: Subject, orgId: string | null, id: string): Promise<void> {
  const db = await dbOf(deps);
  const now = deps.now();
  const row = await db.first<Row>(`${SELECT} WHERE i.id = ?`, [id]);
  if (!row || !pending(row, now) || (orgId !== null && row.org_id !== orgId)) throw notFound();
  authorize(subject, orgId === null ? null : row.org_id, row.role);
  await db.batch([
    { sql: "DELETE FROM invites WHERE id = ? AND accepted_at IS NULL", args: [id] },
    auditStmt(now, actor, row.org_id, "invite.revoke", id),
  ]);
}

async function byToken(q: Tx, token: string, now: number): Promise<Row> {
  const [row] = await q.all<Row>(`${SELECT} WHERE i.token_hash = ?`, [await sha256Hex(token)]);
  if (!row || !pending(row, now)) throw inviteInvalid();
  return row;
}

export async function previewInvite(deps: Pick<Deps, "storage" | "now">, token: string): Promise<{ email: string; org_name: string | null }> {
  const row = await byToken(await dbOf(deps), token, deps.now());
  return { email: row.email, org_name: row.org_id ? row.org_name : null };
}

export interface Accepted {
  userId: string;
  email: string;
  existing: boolean;
}

/**
 * Redeems a token once. Order: token validity (404 invite_invalid); existing account:
 * disabled (403 account_disabled), caller must be it (403 invite_login_required); new
 * email: name/password (422 invalid). The caller then starts a session for a new user.
 */
export async function acceptInvite(deps: InviteDeps, token: string, callerId: string | null, body: Record<string, unknown>): Promise<Accepted> {
  const db = await dbOf(deps);
  const now = deps.now();
  // Validate and hash outside the tx (argon2 is slow); the tx re-checks the token.
  const peek = await byToken(db, token, now);
  const existing = await db.first<{ id: string; disabled: number }>("SELECT id, disabled FROM users WHERE email = ? AND deleted_at IS NULL", [peek.email]);
  let hash = "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (existing) {
    if (Number(existing.disabled)) throw forbidden("account_disabled", "account is disabled");
    if (!callerId || callerId !== existing.id) throw forbidden("invite_login_required", "sign in as the invited account first");
  } else {
    const fields: Record<string, string> = {};
    if (!name) fields.name = "required";
    else if ([...name].length > 200) fields.name = "too_long";
    const pw = passwordProblem(body.password);
    if (pw) fields.password = pw;
    if (Object.keys(fields).length) throw invalid(fields);
    hash = await hasherOf(deps).hash(body.password as string);
  }
  return db.tx(async (q) => {
    const row = await byToken(q, token, now);
    const used = await q.run("UPDATE invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL", [now, row.id]);
    if (used.changes !== 1) throw inviteInvalid();
    let userId: string;
    if (existing) userId = existing.id;
    else {
      userId = newId("usr_", now);
      await q.run(
        "INSERT INTO users (id, email, name, pw_hash, must_change, instance_admin, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)",
        [userId, row.email, name, hash, now, now],
      );
    }
    const detail: Record<string, unknown> = { email: row.email, existing: !!existing };
    if (row.org_id) {
      const [m] = await q.all<{ role: string }>("SELECT role FROM members WHERE org_id = ? AND user_id = ?", [row.org_id, userId]);
      if (m) {
        detail.membership = "already_member";
        detail.kept_role = m.role;
      } else {
        await q.run("INSERT INTO members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", [row.org_id, userId, row.role ?? DEFAULT_ROLE, now]);
      }
    }
    const a = auditStmt(now, { userId }, row.org_id, "invite.accept", row.id, detail);
    await q.run(a.sql, a.args);
    return { userId, email: row.email, existing: !!existing };
  });
}
