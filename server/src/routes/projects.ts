// Org projects (api-web §7): CRUD and environments.

import type { Deps } from "../app.ts";
import { authOf, requireSession } from "../auth/middleware.ts";
import { orgAccess } from "../orgs/members.ts";
import {
  createProject,
  deleteProject,
  environments,
  getProject,
  listProjects,
  parseCreate,
  parsePatch,
  updateProject,
} from "../keys/projects.ts";
import type { Router } from "../http/router.ts";
import { withRuntimeErrors } from "../runtime/errors.ts";
import { json, noContent, readJson } from "../http/json.ts";
import { audit } from "../audit/audit.ts";

export function registerProjects(r: Router, deps: Deps): void {
  const s = (h: Parameters<typeof requireSession>[1]) => requireSession(deps, withRuntimeErrors(h));
  const access = async (ctx: Parameters<Parameters<typeof requireSession>[1]>[0]) => {
    const { user } = authOf(ctx);
    const { org, subject, actor } = await orgAccess(deps, user, ctx.params.org as string);
    return { org, sub: subject, actor };
  };

  r.get(
    "/api/orgs/:org/projects",
    s(async (ctx) => {
      const { org, sub } = await access(ctx);
      return json({ items: await listProjects(deps, org, sub) });
    }),
  );

  r.post(
    "/api/orgs/:org/projects",
    s(async (ctx) => {
      const { org, sub, actor } = await access(ctx);
      const req = parseCreate(await readJson<unknown>(ctx.req));
      const out = await createProject(deps, org, sub, req);
      await audit(deps, { actor, orgId: org.id, action: "project.create", target: req.slug, detail: { environments: out.environments } });
      return json(out, 201);
    }),
  );

  r.get(
    "/api/orgs/:org/projects/:p",
    s(async (ctx) => {
      const { org, sub } = await access(ctx);
      return json(await getProject(deps, org, sub, ctx.params.p as string));
    }),
  );

  r.patch(
    "/api/orgs/:org/projects/:p",
    s(async (ctx) => {
      const { org, sub, actor } = await access(ctx);
      const req = parsePatch(await readJson<unknown>(ctx.req));
      const out = await updateProject(deps, org, sub, ctx.params.p as string, req);
      await audit(deps, { actor, orgId: org.id, action: "project.update", target: ctx.params.p as string, detail: req });
      return json(out);
    }),
  );

  r.delete(
    "/api/orgs/:org/projects/:p",
    s(async (ctx) => {
      const { org, sub, actor } = await access(ctx);
      await deleteProject(deps, org, sub, ctx.params.p as string);
      await audit(deps, { actor, orgId: org.id, action: "project.delete", target: ctx.params.p as string });
      return noContent();
    }),
  );

  r.get(
    "/api/orgs/:org/projects/:p/environments",
    s(async (ctx) => {
      const { org, sub } = await access(ctx);
      return json({ items: await environments(deps, org, sub, ctx.params.p as string) });
    }),
  );
}
