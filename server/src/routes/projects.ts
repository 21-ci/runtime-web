// Org projects (api-web §7): CRUD and environments.

import type { Deps } from "../app.ts";
import { authOf, requireSession } from "../auth/middleware.ts";
import { loadOrg } from "../keys/access.ts";
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
import { withRuntimeErrors } from "../keys/errors.ts";
import { json, noContent, readJson } from "../http/json.ts";

export function registerProjects(r: Router, deps: Deps): void {
  const s = (h: Parameters<typeof requireSession>[1]) => requireSession(deps, withRuntimeErrors(h));
  const access = async (ctx: Parameters<Parameters<typeof requireSession>[1]>[0]) => {
    const { user } = authOf(ctx);
    return loadOrg(deps, ctx.params.org as string, user);
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
      const { org, sub } = await access(ctx);
      const req = parseCreate(await readJson<unknown>(ctx.req));
      return json(await createProject(deps, org, sub, req), 201);
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
      const { org, sub } = await access(ctx);
      const req = parsePatch(await readJson<unknown>(ctx.req));
      return json(await updateProject(deps, org, sub, ctx.params.p as string, req));
    }),
  );

  r.delete(
    "/api/orgs/:org/projects/:p",
    s(async (ctx) => {
      const { org, sub } = await access(ctx);
      await deleteProject(deps, org, sub, ctx.params.p as string);
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
