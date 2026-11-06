// Org quota view and usage (api-web §7 and §6 admin usage).

import type { Deps } from "../app.ts";
import { authOf, requireSession } from "../auth/middleware.ts";
import { dbOf } from "../auth/types.ts";
import { audit, auditIn } from "../audit/audit.ts";
import { orgAccess } from "../orgs/members.ts";
import { getOrgBySlug } from "../orgs/orgs.ts";
import { orgLimits, orgPlanUsage, orgUsage, parseRange, type UsageJson } from "../keys/usage.ts";
import { notFound } from "../http/errors.ts";
import { csvLine, exportFileName, exportFormat, exportResponse } from "../http/export.ts";
import type { Router } from "../http/router.ts";
import { withRuntimeErrors } from "../runtime/errors.ts";
import { json } from "../http/json.ts";

function usageCsv(now: number, slug: string, range: { from?: string; to?: string }, items: UsageJson[]): Promise<Response> {
  return exportResponse({
    fileName: exportFileName([slug], "usage", range.from ? Date.parse(range.from) : null, range.to ? Date.parse(range.to) : now, "csv"),
    format: "csv",
    header: "app,day,invocations,cpu_ms,egress_bytes,storage_bytes",
    rows: items,
    line: (u) => csvLine([u.app, u.day, u.invocations, u.cpu_ms, u.egress_bytes, u.storage_bytes]),
  });
}

export function registerLimitsUsage(r: Router, deps: Deps): void {
  const s = (h: Parameters<typeof requireSession>[1], admin = false) => requireSession(deps, withRuntimeErrors(h), { admin });

  r.get(
    "/api/orgs/:org/limits",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const { org } = await orgAccess(deps, user, ctx.params.org as string);
      return json(await orgLimits(deps, org));
    }),
  );

  r.get(
    "/api/orgs/:org/usage",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const format = exportFormat(ctx.url.searchParams, ["csv"] as const);
      const { org, actor } = await orgAccess(deps, user, ctx.params.org as string, "org.usage.read");
      const range = parseRange(ctx.url.searchParams);
      const items = await orgUsage(deps, org, range);
      if (!format) return json({ items });
      const res = await usageCsv(deps.now(), org.slug, range, items);
      await audit(deps, { actor, orgId: org.id, action: "org.usage.export", target: org.id, detail: { format, from: range.from ?? null, to: range.to ?? null } });
      return res;
    }),
  );

  r.get(
    "/api/orgs/:org/plan-usage",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const { org } = await orgAccess(deps, user, ctx.params.org as string, "org.usage.read");
      return json(await orgPlanUsage(deps, org));
    }),
  );

  // Instance-admin read of any org's usage; every read is audited.
  r.get(
    "/api/admin/orgs/:org/usage",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const format = exportFormat(ctx.url.searchParams, ["csv"] as const);
      const db = await dbOf(deps);
      const org = await getOrgBySlug(db, ctx.params.org as string);
      if (!org) throw notFound();
      const range = parseRange(ctx.url.searchParams);
      const items = await orgUsage(deps, org, range);
      const now = deps.now();
      await auditIn(db, now, {
        orgId: org.id,
        actor: { userId: user.id },
        action: format ? "org.usage.export" : "org.usage.read",
        target: org.id,
        detail: { from: range.from ?? null, to: range.to ?? null },
      });
      return format ? usageCsv(now, org.slug, range, items) : json({ items });
    }, true),
  );
}
