// Org quota view and usage (api-web §7 and §6 admin usage).

import type { Deps } from "../app.ts";
import { authOf, requireSession } from "../auth/middleware.ts";
import { dbOf } from "../auth/types.ts";
import { auditIn } from "../audit/audit.ts";
import { orgAccess } from "../orgs/members.ts";
import { getOrgBySlug } from "../orgs/orgs.ts";
import { orgLimits, orgUsage, parseRange } from "../keys/usage.ts";
import { notFound } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { withRuntimeErrors } from "../runtime/errors.ts";
import { json } from "../http/json.ts";

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
      const { org } = await orgAccess(deps, user, ctx.params.org as string, "org.usage.read");
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
      const org = await getOrgBySlug(db, ctx.params.org as string);
      if (!org) throw notFound();
      const range = parseRange(ctx.url.searchParams);
      const items = await orgUsage(deps, org, range);
      const now = deps.now();
      await auditIn(db, now, {
        orgId: org.id,
        actor: { userId: user.id },
        action: "org.usage.read",
        target: org.id,
        detail: { from: range.from ?? null, to: range.to ?? null },
      });
      return json({ items });
    }, true),
  );
}
