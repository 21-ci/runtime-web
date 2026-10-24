// App custom domains (api-web §8.5) and the instance-wide domain list (§6).
// Routes answer 404 for an org or app the caller cannot see, 403 when they can see
// it but lack the role (domains.manage = project admin).

import type { Deps } from "../app.ts";
import { authOf, requireAdmin, requireSession, withRetryAfter } from "../auth/middleware.ts";
import { dbOf } from "../auth/types.ts";
import { json, noContent, readJson } from "../http/json.ts";
import { invalid, notFound } from "../http/errors.ts";
import type { Router, RequestContext } from "../http/router.ts";
import { orgBySlug, requireProject, subjectFor, type Subject } from "../domains/access.ts";
import {
  addDomain,
  type DomainRow,
  getDomain,
  listDomains,
  removeDomain,
  verifyDomain,
  viewOf,
} from "../domains/domains.ts";
import type { AppRef } from "../domains/types.ts";
import type { Db } from "../storage/types.ts";
import { withRuntimeErrors } from "../runtime/errors.ts";

/** Resolves /api/orgs/{org}/apps/{app} for the caller and checks the project role. */
async function appScope(deps: Deps, ctx: RequestContext, need: "viewer" | "admin") {
  const { user } = authOf(ctx);
  const db: Db = await dbOf(deps);
  const org = await orgBySlug(db, ctx.params.org ?? "");
  const sub: Subject = await subjectFor(db, user, org.id);
  if (!sub.instanceAdmin && sub.orgRole === null) throw notFound();
  const app: AppRef | null = deps.apps ? await deps.apps.resolve(org.id, ctx.params.app ?? "") : null;
  if (!app) throw notFound();
  requireProject(sub, app.projectSlug, need);
  const actor = { userId: user.id, asInstanceAdmin: sub.orgRole === null };
  return { db, org, app, actor };
}

async function domainInScope(db: Db, orgId: string, serviceId: string, id: string): Promise<DomainRow> {
  const d = await getDomain(db, id);
  if (!d || d.org_id !== orgId || d.service_id !== serviceId) throw notFound();
  return d;
}

export function registerDomains(r: Router, deps: Deps): void {
  const base = "/api/orgs/:org/apps/:app/domains";

  r.get(
    base,
    requireSession(
      deps,
      withRetryAfter(async (ctx) => {
        const { db, app } = await appScope(deps, ctx, "viewer");
        const rows = await listDomains(db, app.serviceId);
        return json({ items: rows.map((d) => viewOf(deps, d)) });
      }),
    ),
  );

  r.post(
    base,
    requireSession(
      deps,
      withRetryAfter(
        withRuntimeErrors(async (ctx) => {
          const { app, actor, org } = await appScope(deps, ctx, "admin");
          const body = await readJson<{ host?: unknown }>(ctx.req);
          if (typeof body.host !== "string") throw invalid({ host: "required" });
          const d = await addDomain(deps, { orgId: org.id, app, host: body.host, actor });
          return json(viewOf(deps, d), 201);
        }),
      ),
    ),
  );

  r.post(
    `${base}/:id/verify`,
    requireSession(
      deps,
      withRetryAfter(
        withRuntimeErrors(async (ctx) => {
          const { db, app, actor, org } = await appScope(deps, ctx, "admin");
          const d = await domainInScope(db, org.id, app.serviceId, ctx.params.id ?? "");
          const out = await verifyDomain(deps, d, actor);
          return json(viewOf(deps, out));
        }),
      ),
    ),
  );

  r.delete(
    `${base}/:id`,
    requireSession(
      deps,
      withRetryAfter(
        withRuntimeErrors(async (ctx) => {
          const { db, app, actor, org } = await appScope(deps, ctx, "admin");
          const d = await domainInScope(db, org.id, app.serviceId, ctx.params.id ?? "");
          await removeDomain(deps, d, actor);
          return noContent();
        }),
      ),
    ),
  );

  r.get(
    "/api/admin/domains",
    requireAdmin(
      deps,
      withRetryAfter(async () => {
        const db = await dbOf(deps);
        const rows = await db.all<DomainRow & { org_slug: string; org_name: string }>(
          `SELECT d.*, o.slug AS org_slug, o.name AS org_name FROM domains d JOIN orgs o ON o.id = d.org_id
           ORDER BY d.created_at, d.id`,
        );
        return json({
          items: rows.map((d) => ({ ...viewOf(deps, d), org: { slug: d.org_slug, name: d.org_name } })),
        });
      }),
    ),
  );
}
