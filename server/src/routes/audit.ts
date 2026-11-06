// Audit reads: instance-wide (api-web §6, admin) and per org (§7, org owners and admins).
// Entries are written by audit(deps, event) from the modules that change state.

import type { Deps } from "../app.ts";
import { authOf, requireAdmin, requireSession, withRetryAfter } from "../auth/middleware.ts";
import { dbOf } from "../auth/types.ts";
import { audit, listAudit, type AuditEntry, type AuditFilter } from "../audit/audit.ts";
import { csvLine, exportFileName, exportFormat, exportResponse, isoTime, rangeBound } from "../http/export.ts";
import type { Actor } from "../orgs/common.ts";
import type { Db } from "../storage/types.ts";
import { orgAccess } from "../orgs/members.ts";
import { getOrgBySlug } from "../orgs/orgs.ts";
import { notFound } from "../http/errors.ts";
import { json } from "../http/json.ts";
import { invalid } from "../http/errors.ts";
import type { RequestContext, Router } from "../http/router.ts";

// exclude_action is a comma-separated list of action names, at most 20.
function excludeFrom(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const list = raw.split(",").map((a) => a.trim()).filter(Boolean);
  if (list.length > 20 || list.some((a) => !/^[a-z0-9_.]{1,64}$/.test(a))) throw invalid({ exclude_action: "invalid" });
  return list;
}

function filterFrom(ctx: RequestContext, orgId: string | undefined): AuditFilter {
  const q = ctx.url.searchParams;
  const since = rangeBound(q, "since").ms;
  const until = rangeBound(q, "until").ms;
  const limitRaw = q.get("limit");
  let limit: number | undefined;
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1) throw invalid({ limit: "must_be_positive_integer" });
    limit = Number(limitRaw);
  }
  return {
    orgId,
    actorId: q.get("actor") || undefined,
    action: q.get("action") || undefined,
    excludeActions: excludeFrom(q.get("exclude_action")),
    ...(since !== null ? { since } : {}),
    ...(until !== null ? { until } : {}),
    cursor: q.get("cursor") || undefined,
    limit,
  };
}

const EXPORT_PAGE = 500;

async function* auditRows(db: Db, filter: AuditFilter) {
  let cursor = filter.cursor;
  for (;;) {
    const page = await listAudit(db, { ...filter, limit: EXPORT_PAGE, ...(cursor ? { cursor } : {}) });
    yield* page.items;
    if (!page.next_cursor) return;
    cursor = page.next_cursor;
  }
}

const NDJSON = (e: AuditEntry) => JSON.stringify(e);
const CSV = (e: AuditEntry) =>
  csvLine([isoTime(e.at), e.actor.name, e.actor.email, e.actor.user_id, e.as_instance_admin, e.org?.slug ?? "", e.action, e.target, e.detail]);

/** The filtered log as a file. The export itself is audited once its first page has been read. */
async function auditExport(deps: Deps, db: Db, filter: AuditFilter, format: "csv" | "ndjson", name: string, actor: Actor): Promise<Response> {
  const res = await exportResponse({
    fileName: exportFileName([name], "audit", filter.since ?? null, filter.until ?? deps.now(), format),
    format,
    rows: auditRows(db, filter),
    line: format === "csv" ? CSV : NDJSON,
    ...(format === "csv" ? { header: "at,actor,actor_email,actor_id,as_instance_admin,org,action,target,detail" } : {}),
  });
  await audit(deps, { actor, orgId: filter.orgId ?? null, action: "audit.export", target: name, detail: { format, actor: filter.actorId ?? null, action: filter.action ?? null, since: filter.since ?? null, until: filter.until ?? null } });
  return res;
}

export function registerAudit(r: Router, deps: Deps): void {
  r.get(
    "/api/admin/audit",
    requireAdmin(
      deps,
      withRetryAfter(async (ctx) => {
        const format = exportFormat(ctx.url.searchParams, ["csv", "ndjson"] as const);
        const db = await dbOf(deps);
        const slug = ctx.url.searchParams.get("org");
        const org = slug ? await getOrgBySlug(db, slug) : null;
        if (slug && !org) throw notFound();
        const orgId = org?.id;
        const filter = filterFrom(ctx, orgId);
        if (format) return auditExport(deps, db, filter, format, slug ?? "instance", { userId: authOf(ctx).user.id });
        return json(await listAudit(db, filter));
      }),
    ),
  );

  r.get(
    "/api/orgs/:org/audit",
    requireSession(
      deps,
      withRetryAfter(async (ctx) => {
        const { user } = authOf(ctx);
        const format = exportFormat(ctx.url.searchParams, ["csv", "ndjson"] as const);
        const db = await dbOf(deps);
        const { org, actor } = await orgAccess(deps, user, ctx.params.org ?? "", "org.audit.read");
        const filter = filterFrom(ctx, org.id);
        if (format) return auditExport(deps, db, filter, format, org.slug, actor);
        return json(await listAudit(db, filter));
      }),
    ),
  );
}
