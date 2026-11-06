// Git deploys: the signed webhook (public), the link and its rules (project admins), and the CI deploy route.

import type { Deps } from "../app.ts";
import { audit } from "../audit/audit.ts";
import { authOf, requireSession, withRetryAfter } from "../auth/middleware.ts";
import * as A from "../apps/service.ts";
import { deploy } from "../git/deploy.ts";
import { receiveWebhook } from "../git/deliveries.ts";
import { createLink, deleteLink, getLink, putRules, updateLink } from "../git/links.ts";
import { approvePreview, deletePreview, getPreviewEnv, listPreviews, putPreviewEnv } from "../git/previews.ts";
import { json, noContent, readJson } from "../http/json.ts";
import type { Handler, RequestContext, Router } from "../http/router.ts";
import { orgAccess } from "../orgs/members.ts";

type AppHandler = (c: A.OrgCtx, ctx: RequestContext) => Promise<Response>;

export function registerGit(router: Router, deps: Deps): void {
  const route = (h: AppHandler): Handler =>
    withRetryAfter(
      requireSession(deps, async (ctx) => {
        const { user } = authOf(ctx);
        const { org, subject, actor } = await orgAccess(deps, user, ctx.params.org ?? "");
        return h({ deps, org, sub: subject, actor, cli: await A.orgClient(deps, org) }, ctx);
      }),
    );
  const one = "/api/orgs/:org/apps/:app";
  const slug = (ctx: RequestContext) => ctx.params.app ?? "";
  const record = (c: A.OrgCtx, action: string, target: string, detail: unknown) =>
    audit(deps, { actor: c.actor, orgId: c.org.id, action, target, detail });

  router.post("/api/hooks/git/:hook", withRetryAfter((ctx) => receiveWebhook(deps, ctx.params.hook ?? "", ctx.req, ctx.waitUntil)));

  router.get(`${one}/git`, route(async (c, ctx) => json(await getLink(c, slug(ctx)))));

  router.post(`${one}/git`, route(async (c, ctx) => {
    const out = await createLink(c, slug(ctx), await readJson(ctx.req));
    await record(c, "git.link.create", slug(ctx), { provider: out.provider, base_url: out.base_url, repo: out.repo, branch: out.branch, has_token: out.has_token });
    return json(out, 201);
  }));

  router.patch(`${one}/git`, route(async (c, ctx) => {
    const b = await readJson(ctx.req);
    const out = await updateLink(c, slug(ctx), b);
    await record(c, "git.link.update", slug(ctx), { fields: Object.keys(b), branch: out.branch, paused: out.paused, auto_promote: out.auto_promote, has_token: out.has_token });
    return json(out);
  }));

  router.delete(`${one}/git`, route(async (c, ctx) => {
    await deleteLink(c, slug(ctx));
    await record(c, "git.link.delete", slug(ctx), {});
    return noContent();
  }));

  router.put(`${one}/git/rules`, route(async (c, ctx) => {
    const rules = await putRules(c, slug(ctx), await readJson(ctx.req));
    await record(c, "git.rules.update", slug(ctx), { rules });
    return json({ rules });
  }));

  router.get(`${one}/previews`, route(async (c, ctx) => json({ items: await listPreviews(c, slug(ctx)) })));

  router.delete(`${one}/previews/:pr`, route(async (c, ctx) => {
    const { pr } = await deletePreview(c, slug(ctx), ctx.params.pr ?? "");
    await record(c, "preview.delete", slug(ctx), { pr });
    return noContent();
  }));

  router.post(`${one}/previews/:pr/approve`, route(async (c, ctx) => {
    const out = await approvePreview(c, slug(ctx), ctx.params.pr ?? "", await readJson(ctx.req));
    await record(c, "preview.approve", slug(ctx), out);
    return json(out);
  }));

  router.get(`${one}/preview-env`, route(async (c, ctx) => json(await getPreviewEnv(c, slug(ctx)))));

  router.put(`${one}/preview-env`, route(async (c, ctx) => {
    const names = await putPreviewEnv(c, slug(ctx), await readJson(ctx.req));
    await record(c, "preview.env", slug(ctx), { names });
    return noContent();
  }));

  router.post(`${one}/deploys`, route(async (c, ctx) => {
    const b = await readJson(ctx.req);
    const { host, target, ...out } = await deploy(c, slug(ctx), b);
    await record(c, "app.deploy", slug(ctx), { host, target, version: out.version, sha: b.sha ?? null, ref: b.ref ?? null });
    return json(out, 202);
  }));
}
