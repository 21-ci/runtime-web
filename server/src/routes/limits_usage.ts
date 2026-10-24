// Org quota view and usage (api-web §7 and §6 admin usage).

import type { Deps } from "../app.ts";
import { authOf, requireSession } from "../auth/middleware.ts";
import { dbOf } from "../auth/types.ts";
import { writeAudit } from "../keys/audit_row.ts";
import { canOrg, loadOrg, orgBySlug } from "../keys/access.ts";
import { orgLimits, orgUsage, parseRange } from "../keys/usage.ts";
import { forbidden, notFound } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { withRuntimeErrors } from "../keys/errors.ts";
import { json } from "../http/json.ts";

export function registerLimitsUsage(r: Router, deps: Deps): void {
  const s = (h: Parameters<typeof requireSession>[1], admin = false) => requireSession(deps, withRuntimeErrors(h), { admin });

  r.get(
    "/api/orgs/:org/limits",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const { org } = await loadOrg(deps, ctx.params.org as string, user);
      return json(await orgLimits(deps, org));
    }),
  );

  r.get(
    "/api/orgs/:org/usage",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const { org, sub } = await loadOrg(deps, ctx.params.org as string, user);
      if (!canOrg(sub, "org.usage.read")) throw forbidden("forbidden", "not allowed");
      const range = parseRange(ctx.url.searchParams);
      return json({ items: await orgUsage(deps, org, range) });
    }),
  );

  // Instance-admin read of any org's usage; every read is audited.
  r.get(
    "/api/admin/orgs/:org/usage",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const db = await dbOf(deps);
      const org = await orgBySlug(db, ctx.params.org as string);
      if (!org) throw notFound();
      const range = parseRange(ctx.url.searchParams);
      const items = await orgUsage(deps, org, range);
      const now = deps.now();
      await writeAudit(db, now, {
        orgId: org.id,
        actorId: user.id,
        action: "org.usage.read",
        target: org.id,
        data: { from: range.from ?? null, to: range.to ?? null },
      });
      return json({ items });
    }, true),
  );
}
