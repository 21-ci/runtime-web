// Custom domains for apps (port of internal/domains). A host is claimed as `pending`,
// verified by a TXT record at `_rtweb.<host>`, and mapped on the runtime (operator PUT
// …/hosts/{h}) only after the TXT matches. Only `active` hosts are routed (tls-ask).
// Callers pass an authorised app; this module does data, runtime and audit work.

import type { Deps } from "../app.ts";
import { auditStmt, type AuditActor } from "../audit/audit.ts";
import { newId, randomBytes } from "../crypto/random.ts";
import { Runtime, isNotFound, isRuntimeError } from "../runtime/client.ts";
import { conflict, invalid } from "../http/errors.ts";
import type { Db, Stmt } from "../storage/types.ts";
import { dohTxt } from "./doh.ts";
import type { AppRef, TxtLookup } from "./types.ts";

export const STATUS_PENDING = "pending";
export const STATUS_ACTIVE = "active";
export const STATUS_FAILED = "failed";
export const TXT_PREFIX = "_rtweb.";
const MAX_HOST_LEN = 253;

export type DomainDeps = Pick<Deps, "storage" | "now" | "config" | "rtctl" | "txt" | "fetch">;

export type DomainRow = {
  id: string;
  org_id: string;
  app_slug: string;
  project_slug: string;
  service_id: string;
  host: string;
  txt_token: string;
  status: string;
  created_at: number;
  verified_at: number | null;
  last_checked_at: number | null;
  txt_misses: number;
};

/** api-web Domain (§8.5). Certificates are not managed in v1: cert_status stays "none". */
export interface DomainView {
  id: string;
  host: string;
  app: string;
  status: string;
  txt_name: string;
  txt_value: string;
  cname_target: string;
  last_checked_at: number | null;
  verified_at: number | null;
  cert_status: "none";
  cert_not_after: null;
  cert_error: null;
  created_at: number;
}

export const consoleHost = (origin: string): string => {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return "";
  }
};

export function txtLookupOf(deps: DomainDeps): TxtLookup {
  return deps.txt ?? dohTxt(deps.fetch ?? fetch);
}

export function runtimeOf(deps: DomainDeps): Runtime {
  if (!deps.rtctl) throw new Error("domains: rtctl not configured");
  return new Runtime(deps.rtctl);
}

export function viewOf(deps: Pick<DomainDeps, "config">, r: DomainRow): DomainView {
  return {
    id: r.id,
    host: r.host,
    app: r.app_slug,
    status: r.status,
    txt_name: TXT_PREFIX + r.host,
    txt_value: r.txt_token,
    cname_target: consoleHost(deps.config.origin),
    last_checked_at: r.last_checked_at,
    verified_at: r.verified_at,
    cert_status: "none",
    cert_not_after: null,
    cert_error: null,
    created_at: r.created_at,
  };
}

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Canonical form of a user-supplied host: lowercase punycode, no trailing dot.
 * IPs, wildcards, ports, single labels, numeric TLDs, over-long names and the
 * console host are 422 invalid.
 */
export function normalizeHost(raw: string, reservedHost: string): string {
  const fail = (why: string) => invalid({ host: why });
  const h = raw.trim().replace(/\.$/, "");
  if (h === "") throw fail("empty");
  if (/[:*/[\]@\s]/.test(h)) throw fail("not a plain host name");
  if (/^[\d.]+$/.test(h)) throw fail("ip address or numeric host");
  let a: string;
  try {
    a = new URL(`http://${h}`).hostname.toLowerCase();
  } catch {
    throw fail("invalid host");
  }
  if (a.length > MAX_HOST_LEN) throw fail("too long");
  const labels = a.split(".");
  if (labels.length < 2) throw fail("single label");
  if (!labels.every((l) => LABEL_RE.test(l))) throw fail("bad label");
  if (/^\d+$/.test(labels[labels.length - 1] ?? "")) throw fail("numeric tld");
  if (a === reservedHost) throw fail("reserved host");
  return a;
}

const isUnique = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/.test(e.message);

export function newToken(): string {
  return Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getDomain(db: Db, id: string): Promise<DomainRow | null> {
  return db.first<DomainRow>("SELECT * FROM domains WHERE id = ?", [id]);
}

export async function listDomains(db: Db, serviceId: string): Promise<DomainRow[]> {
  return db.all<DomainRow>("SELECT * FROM domains WHERE service_id = ? ORDER BY created_at, id", [serviceId]);
}

/** Claims host for app as pending. A host already claimed anywhere is 409 host_taken. */
export async function addDomain(deps: DomainDeps, a: { orgId: string; app: AppRef; host: string; actor: AuditActor }): Promise<DomainRow> {
  const h = normalizeHost(a.host, consoleHost(deps.config.origin));
  const existing = await deps.storage.db.first<{ org_id: string }>("SELECT org_id FROM domains WHERE host = ?", [h]);
  if (existing) {
    const msg = existing.org_id === a.orgId ? "This org already has the domain." : "This host is already in use.";
    throw conflict("host_taken", msg);
  }
  const now = deps.now();
  const row: DomainRow = {
    id: newId("dom_", now),
    org_id: a.orgId,
    app_slug: a.app.slug,
    project_slug: a.app.projectSlug,
    service_id: a.app.serviceId,
    host: h,
    txt_token: newToken(),
    status: STATUS_PENDING,
    created_at: now,
    verified_at: null,
    last_checked_at: null,
    txt_misses: 0,
  };
  try {
    await deps.storage.db.batch([
      {
        sql: `INSERT INTO domains (id, org_id, app_slug, project_slug, service_id, host, txt_token, status, created_at, verified_at, last_checked_at, txt_misses)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)`,
        args: [row.id, row.org_id, row.app_slug, row.project_slug, row.service_id, row.host, row.txt_token, row.status, row.created_at],
      },
      auditStmt(deps, { actor: a.actor, orgId: a.orgId, action: "domain.add", target: h, detail: { app: a.app.slug } }),
    ]);
  } catch (e) {
    if (isUnique(e)) throw conflict("host_taken", "This host is already in use.");
    throw e;
  }
  return row;
}

async function setStatus(db: Db, id: string, status: string): Promise<void> {
  await db.run("UPDATE domains SET status = ? WHERE id = ?", [status, id]);
}

export async function markChecked(db: Db, id: string, at: number, misses: number): Promise<void> {
  await db.run("UPDATE domains SET last_checked_at = ?, txt_misses = ? WHERE id = ?", [at, misses, id]);
}

/** True when a TXT record at _rtweb.<host> holds the token. Lookup errors count as a miss. */
export async function txtMatches(deps: DomainDeps, d: Pick<DomainRow, "host" | "txt_token">): Promise<boolean> {
  try {
    const vals = await txtLookupOf(deps)(TXT_PREFIX + d.host);
    return vals.some((v) => v.trim() === d.txt_token);
  } catch {
    return false;
  }
}

/**
 * Maps the host on the runtime, then marks the row active. A runtime 409 (held by
 * another tenant's service) leaves the row failed with 409 host_taken.
 * Throws the runtime error mapped by the caller for other failures; the row is untouched.
 */
export async function activate(deps: DomainDeps, d: DomainRow, actor: AuditActor, rt?: Runtime): Promise<DomainRow> {
  const client = rt ?? runtimeOf(deps);
  try {
    await client.op().putHost(d.service_id, d.host);
  } catch (e) {
    if (isRuntimeError(e) && e.status === 409) {
      await setStatus(deps.storage.db, d.id, STATUS_FAILED);
      throw conflict("host_taken", "This host is already in use.");
    }
    throw e;
  }
  const at = deps.now();
  const stmts: Stmt[] = [
    { sql: "UPDATE domains SET status = ?, verified_at = ?, last_checked_at = ?, txt_misses = 0 WHERE id = ?", args: [STATUS_ACTIVE, at, at, d.id] },
    auditStmt(deps, { actor, orgId: d.org_id, action: "domain.verify", target: d.host, detail: { app: d.app_slug } }),
  ];
  await deps.storage.db.batch(stmts);
  return { ...d, status: STATUS_ACTIVE, verified_at: at, last_checked_at: at, txt_misses: 0 };
}

/** Verify now: activate on a TXT match; otherwise keep the status and record the check. */
export async function verifyDomain(deps: DomainDeps, d: DomainRow, actor: AuditActor): Promise<DomainRow> {
  if (d.status === STATUS_ACTIVE) return d;
  if (await txtMatches(deps, d)) return activate(deps, d, actor);
  await markChecked(deps.storage.db, d.id, deps.now(), d.txt_misses);
  return (await getDomain(deps.storage.db, d.id)) ?? d;
}

export type PendingUnmap = {
  id: string;
  org_id: string;
  service_id: string;
  host: string;
};

/** Deletes the row (and, for an active host, queues the runtime DELETE) in one batch, then runs the DELETE. */
export async function removeDomain(deps: DomainDeps, d: DomainRow, actor: AuditActor): Promise<void> {
  const now = deps.now();
  const stmts: Stmt[] = [{ sql: "DELETE FROM domains WHERE id = ?", args: [d.id] }];
  let m: PendingUnmap | null = null;
  if (d.status === STATUS_ACTIVE) {
    m = { id: newId("unm_", now), org_id: d.org_id, service_id: d.service_id, host: d.host };
    stmts.push({
      sql: "INSERT INTO pending_unmaps (id, org_id, service_id, host, created_at) VALUES (?, ?, ?, ?, ?)",
      args: [m.id, m.org_id, m.service_id, m.host, now],
    });
  }
  stmts.push(auditStmt(deps, { actor, orgId: d.org_id, action: "domain.remove", target: d.host }));
  await deps.storage.db.batch(stmts);
  if (m) await unmapHost(deps, m);
}

/**
 * Deletes host on the runtime and clears the marker. A missing host counts as done;
 * on failure the marker stays for the checker to retry. Returns whether it is done.
 */
export async function unmapHost(deps: DomainDeps, m: PendingUnmap): Promise<boolean> {
  const db = deps.storage.db;
  const still = await db.first<{ id: string }>("SELECT id FROM domains WHERE host = ? AND service_id = ? AND status = ?", [m.host, m.service_id, STATUS_ACTIVE]);
  if (still) {
    await db.run("DELETE FROM pending_unmaps WHERE id = ?", [m.id]);
    return true;
  }
  try {
    await runtimeOf(deps).op().deleteHost(m.service_id, m.host);
  } catch (e) {
    if (!isNotFound(e)) return false;
  }
  await db.run("DELETE FROM pending_unmaps WHERE id = ?", [m.id]);
  return true;
}

export async function listHostsOf(deps: DomainDeps, serviceId: string) {
  return runtimeOf(deps).op().listHosts(serviceId);
}

/** Removes every domain of a deleted app (rows, and runtime hosts of active ones). */
export async function removeAppDomains(deps: DomainDeps, serviceId: string, actor: AuditActor): Promise<void> {
  for (const d of await listDomains(deps.storage.db, serviceId)) await removeDomain(deps, d, actor);
}
