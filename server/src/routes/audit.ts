// Audit reads: instance-wide (api-web §6, admin) and per org (§7, org owners and admins).
// Entries are written by audit(deps, event) from the modules that change state.

import type { Deps } from "../app.ts";
import { authOf, requireAdmin, requireSession, withRetryAfter } from "../auth/middleware.ts";
import { dbOf } from "../auth/types.ts";
import { listAudit, type AuditFilter } from "../audit/audit.ts";
import { orgAccess } from "../orgs/members.ts";
import { getOrgBySlug } from "../orgs/orgs.ts";
import { notFound } from "../http/errors.ts";
import { json } from "../http/json.ts";
import { invalid } from "../http/errors.ts";
import type { RequestContext, Router } from "../http/router.ts";

function filterFrom(ctx: RequestContext, orgId: string | undefined): AuditFilter {
  const q = ctx.url.searchParams;
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
    cursor: q.get("cursor") || undefined,
    limit,
  };
}

export function registerAudit(r: Router, deps: Deps): void {
  r.get(
    "/api/admin/audit",
    requireAdmin(
      deps,
      withRetryAfter(async (ctx) => {
        const db = await dbOf(deps);
        const slug = ctx.url.searchParams.get("org");
        const org = slug ? await getOrgBySlug(db, slug) : null;
        if (slug && !org) throw notFound();
        const orgId = org?.id;
        return json(await listAudit(db, filterFrom(ctx, orgId)));
      }),
    ),
  );

  r.get(
    "/api/orgs/:org/audit",
    requireSession(
      deps,
      withRetryAfter(async (ctx) => {
        const { user } = authOf(ctx);
        const db = await dbOf(deps);
        const { org } = await orgAccess(deps, user, ctx.params.org ?? "", "org.audit.read");
        return json(await listAudit(db, filterFrom(ctx, org.id)));
      }),
    ),
  );
}
