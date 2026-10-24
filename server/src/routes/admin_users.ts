// /api/admin/users* and /api/admin/orgs* (api-web §6). Instance admins only.

import type { Deps } from "../app.ts";
import { authOf, requireAdmin } from "../auth/middleware.ts";
import { dbOf } from "../auth/types.ts";
import { notFound } from "../http/errors.ts";
import type { RequestContext, Router } from "../http/router.ts";
import { json, noContent, readJson } from "../http/json.ts";
import type { Actor } from "../orgs/common.ts";
import { createOrg, deleteOrg, getOrgBySlug, listOrgs, orgJson, renameOrg } from "../orgs/orgs.ts";
import { createUser, deleteUser, listUsers, resetUserPassword, resetUserTotp, updateUser } from "../users/users.ts";

const actorOf = (ctx: RequestContext): Actor => ({ userId: authOf(ctx).user.id });

export function registerAdminUsers(r: Router, deps: Deps): void {
  const a = (h: Parameters<typeof requireAdmin>[1]) => requireAdmin(deps, h);
  const id = (ctx: RequestContext) => ctx.params.id as string;

  r.get(
    "/api/admin/users",
    a(async (ctx) => {
      const q = ctx.url.searchParams;
      return json(await listUsers(deps, { cursor: q.get("cursor"), limit: q.get("limit"), q: q.get("q") }));
    }),
  );
  r.post(
    "/api/admin/users",
    a(async (ctx) => {
      const out = await createUser(deps, actorOf(ctx), await readJson(ctx.req));
      return json({ user: out.user, temp_password: out.tempPassword }, 201);
    }),
  );
  r.patch(
    "/api/admin/users/:id",
    a(async (ctx) => json(await updateUser(deps, actorOf(ctx), id(ctx), await readJson(ctx.req)))),
  );
  r.delete(
    "/api/admin/users/:id",
    a(async (ctx) => {
      await deleteUser(deps, actorOf(ctx), id(ctx));
      return noContent();
    }),
  );
  r.post(
    "/api/admin/users/:id/reset-password",
    a(async (ctx) => json({ temp_password: await resetUserPassword(deps, actorOf(ctx), id(ctx)) })),
  );
  r.delete(
    "/api/admin/users/:id/totp",
    a(async (ctx) => {
      await resetUserTotp(deps, actorOf(ctx), id(ctx));
      return noContent();
    }),
  );

  const org = async (ctx: RequestContext) => {
    const o = await getOrgBySlug(await dbOf(deps), ctx.params.org as string);
    if (!o) throw notFound();
    return o;
  };
  const roleIn = async (ctx: RequestContext, orgId: string) =>
    (await dbOf(deps).then((db) => db.first<{ role: string }>("SELECT role FROM members WHERE org_id = ? AND user_id = ?", [orgId, authOf(ctx).user.id])))?.role ?? null;

  r.get(
    "/api/admin/orgs",
    a(async (ctx) => {
      const rows = await listOrgs(await dbOf(deps), authOf(ctx).user.id, true);
      return json({ items: rows.map((x) => orgJson(x.org, x.role)) });
    }),
  );
  r.post(
    "/api/admin/orgs",
    a(async (ctx) => {
      const body = await readJson(ctx.req);
      const o = await createOrg(deps, actorOf(ctx), { slug: body.slug, name: body.name, ownerUserId: body.owner_user_id });
      return json(orgJson(o, await roleIn(ctx, o.id)), 201);
    }),
  );
  r.patch(
    "/api/admin/orgs/:org",
    a(async (ctx) => {
      const o = await renameOrg(deps, actorOf(ctx), await org(ctx), (await readJson(ctx.req)).name);
      return json(orgJson(o, await roleIn(ctx, o.id)));
    }),
  );
  r.delete(
    "/api/admin/orgs/:org",
    a(async (ctx) => {
      await deleteOrg(deps, actorOf(ctx), await org(ctx));
      return noContent();
    }),
  );
}
