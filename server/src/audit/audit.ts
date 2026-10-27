// Append-only audit log. Other modules record events with
// `audit(deps, event)`, or `auditStmt(deps, event)` to put the row in the same batch as
// the change it describes. Listing is keyset-paged, newest first.

import type { Deps } from "../app.ts";
import { newId } from "../crypto/random.ts";
import { invalid } from "../http/errors.ts";
import type { Db, Row, Stmt, Tx } from "../storage/types.ts";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface AuditActor {
  /** usr_… for users, tok_… for bearer tokens, "cli" for host CLI actions, null/absent for system jobs. */
  userId?: string | null;
  /** The actor used instance-admin rights on an org they are not a member of. */
  asInstanceAdmin?: boolean;
}

export interface AuditEvent {
  actor: AuditActor;
  /** Org scope; null/absent records an instance-wide entry. */
  orgId?: string | null;
  action: string;
  target?: string;
  /** Free-form JSON; never put secrets here. */
  detail?: unknown;
}

export type AuditDeps = Pick<Deps, "now" | "storage">;

/** Statement that appends e at `at` (a clock or a timestamp); run it in the caller's batch with the change. */
export function auditStmt(at: Pick<Deps, "now"> | number, e: AuditEvent): Stmt {
  const now = typeof at === "number" ? at : at.now();
  return {
    sql: "INSERT INTO audit (id, ts, org_id, actor_id, action, target, data, as_instance_admin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    args: [
      newId("aud_", now),
      now,
      e.orgId ? e.orgId : null,
      e.actor.userId ? e.actor.userId : null,
      e.action,
      e.target ?? "",
      e.detail === undefined ? null : JSON.stringify(e.detail),
      e.actor.asInstanceAdmin ? 1 : 0,
    ],
  };
}

/** Appends one entry. */
export async function audit(deps: AuditDeps, e: AuditEvent): Promise<void> {
  const s = auditStmt(deps, e);
  await deps.storage.db.run(s.sql, s.args);
}

export interface AuditEntry {
  id: string;
  at: number;
  actor: { user_id: string | null; name: string | null; email: string | null };
  as_instance_admin: boolean;
  org: { id: string; slug: string } | null;
  action: string;
  target: string;
  detail: unknown;
}

export interface AuditFilter {
  orgId?: string | undefined;
  actorId?: string | undefined;
  action?: string | undefined;
  /** Actions to leave out (e.g. routine reads in an overview feed). */
  excludeActions?: string[] | undefined;
  /** Cursor from a previous page ("<ts>:<id>"). */
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface AuditPage {
  items: AuditEntry[];
  next_cursor: string | null;
}

export function encodeCursor(at: number, id: string): string {
  return `${at}:${id}`;
}

export function decodeCursor(c: string): { at: number; id: string } {
  const i = c.indexOf(":");
  const at = i > 0 ? Number(c.slice(0, i)) : Number.NaN;
  const id = i > 0 ? c.slice(i + 1) : "";
  if (!/^\d+$/.test(c.slice(0, i)) || !Number.isFinite(at) || id === "") {
    throw invalid({ cursor: "invalid_cursor" });
  }
  return { at, id };
}

export function clampLimit(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** One page of entries, newest first. next_cursor is null on the last page. */
export async function listAudit(db: Db, f: AuditFilter = {}): Promise<AuditPage> {
  const limit = clampLimit(f.limit);
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.orgId) {
    where.push("a.org_id = ?");
    args.push(f.orgId);
  }
  if (f.actorId) {
    where.push("a.actor_id = ?");
    args.push(f.actorId);
  }
  if (f.action) {
    where.push("a.action = ?");
    args.push(f.action);
  }
  if (f.excludeActions?.length) {
    where.push(`a.action NOT IN (${f.excludeActions.map(() => "?").join(", ")})`);
    args.push(...f.excludeActions);
  }
  if (f.cursor) {
    const c = decodeCursor(f.cursor);
    where.push("(a.ts < ? OR (a.ts = ? AND a.id < ?))");
    args.push(c.at, c.at, c.id);
  }
  const sql = `SELECT a.id, a.ts, a.org_id, a.actor_id, a.action, a.target, a.data, a.as_instance_admin,
      COALESCE(u.name, t.name) AS actor_name, u.email AS actor_email, o.slug AS org_slug
    FROM audit a
    LEFT JOIN users u ON u.id = a.actor_id
    LEFT JOIN tokens t ON t.id = a.actor_id
    LEFT JOIN orgs o ON o.id = a.org_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY a.ts DESC, a.id DESC
    LIMIT ?`;
  const rows = await db.all<Row>(sql, [...args, limit]);
  const items = rows.map(toEntry);
  const last = items.at(-1);
  return {
    items,
    next_cursor: items.length === limit && last ? encodeCursor(last.at, last.id) : null,
  };
}

function toEntry(r: Row): AuditEntry {
  const orgId = r.org_id === null || r.org_id === undefined ? null : String(r.org_id);
  return {
    id: String(r.id),
    at: Number(r.ts),
    actor: {
      user_id: r.actor_id === null || r.actor_id === undefined ? null : String(r.actor_id),
      name: r.actor_name === null || r.actor_name === undefined ? null : String(r.actor_name),
      email: r.actor_email === null || r.actor_email === undefined ? null : String(r.actor_email),
    },
    as_instance_admin: Number(r.as_instance_admin) !== 0,
    org: orgId ? { id: orgId, slug: String(r.org_slug ?? "") } : null,
    action: String(r.action),
    target: r.target === null || r.target === undefined ? "" : String(r.target),
    detail: r.data === null || r.data === undefined ? null : JSON.parse(String(r.data)),
  };
}

/** Appends one entry through q (a Db or an open Tx) at `at`. */
export async function auditIn(q: Pick<Tx, "run">, at: Pick<Deps, "now"> | number, e: AuditEvent): Promise<void> {
  const s = auditStmt(at, e);
  await q.run(s.sql, s.args);
}
