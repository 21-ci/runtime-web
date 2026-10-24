// /api/orgs, /api/orgs/{org}, members and grants (api-web §7).

import type { Deps } from "../app.ts";
import { authOf, requireSession } from "../auth/middleware.ts";
import { dbOf } from "../auth/types.ts";
import type { Router } from "../http/router.ts";
import { json, noContent, readJson } from "../http/json.ts";
import { addMember, listMembers, orgAccess, removeGrant, removeMember, setGrant, setRole } from "../orgs/members.ts";
import { ensureFirstOrg, listOrgs, orgJson } from "../orgs/orgs.ts";

export function registerOrgs(r: Router, deps: Deps): void {
  const s = (h: Parameters<typeof requireSession>[1]) => requireSession(deps, h);

  r.get(
    "/api/orgs",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      await ensureFirstOrg(deps, user);
      const rows = await listOrgs(await dbOf(deps), user.id, user.instanceAdmin);
      return json({ items: rows.map((x) => orgJson(x.org, x.role)) });
    }),
  );

  r.get(
    "/api/orgs/:org",
    s(async (ctx) => {
      const a = await orgAccess(deps, authOf(ctx).user, ctx.params.org as string, "org.read");
      return json(orgJson(a.org, a.subject.orgRole ?? null));
    }),
  );

  r.get(
    "/api/orgs/:org/members",
    s(async (ctx) => {
      const a = await orgAccess(deps, authOf(ctx).user, ctx.params.org as string, "org.read");
      return json({ items: await listMembers(deps, a.org.id) });
    }),
  );

  r.post(
    "/api/orgs/:org/members",
    s(async (ctx) => {
      const a = await orgAccess(deps, authOf(ctx).user, ctx.params.org as string);
      const body = await readJson(ctx.req);
      return json(await addMember(deps, a, body.user_id, body.role), 201);
    }),
  );

  r.patch(
    "/api/orgs/:org/members/:user",
    s(async (ctx) => {
      const a = await orgAccess(deps, authOf(ctx).user, ctx.params.org as string);
      const body = await readJson(ctx.req);
      return json(await setRole(deps, a, ctx.params.user as string, body.role));
    }),
  );

  r.delete(
    "/api/orgs/:org/members/:user",
    s(async (ctx) => {
      const a = await orgAccess(deps, authOf(ctx).user, ctx.params.org as string);
      await removeMember(deps, a, ctx.params.user as string);
      return noContent();
    }),
  );

  r.put(
    "/api/orgs/:org/members/:user/grants/:project",
    s(async (ctx) => {
      const a = await orgAccess(deps, authOf(ctx).user, ctx.params.org as string);
      const body = await readJson(ctx.req);
      return json(await setGrant(deps, a, ctx.params.user as string, ctx.params.project as string, body.role));
    }),
  );

  r.delete(
    "/api/orgs/:org/members/:user/grants/:project",
    s(async (ctx) => {
      const a = await orgAccess(deps, authOf(ctx).user, ctx.params.org as string);
      await removeGrant(deps, a, ctx.params.user as string, ctx.params.project as string);
      return noContent();
    }),
  );
}
