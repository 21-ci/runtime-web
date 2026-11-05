// Alert channels and rules, per org (org admins) and for the instance (instance admins). Bearer tokens never reach
// these: bearerPathAllowed keeps them on App routes.

import type { Deps } from "../app.ts";
import * as A from "../apps/service.ts";
import { createChannel, deleteChannel, listChannels, testChannel, updateChannel } from "../alerts/channels.ts";
import { activeAlerts, createRule, deleteRule, listRules, updateRule } from "../alerts/rules.ts";
import { audit } from "../audit/audit.ts";
import { authOf, requireAdmin, requireSession, withRetryAfter } from "../auth/middleware.ts";
import { json, noContent, readJson } from "../http/json.ts";
import type { Handler, RequestContext, Router } from "../http/router.ts";
import { orgAccess, type OrgAccess } from "../orgs/members.ts";
import type { Actor } from "../orgs/common.ts";

interface Scope {
  orgId: string | null;
  userId: string;
  actor: Actor;
  appId(slug: string): Promise<string>;
}

type ScopeOf = (h: (s: Scope, ctx: RequestContext) => Promise<Response>, write: boolean) => Handler;

const noApps = async (): Promise<string> => {
  throw new Error("alerts: an instance rule has no App");
};

function routes(router: Router, deps: Deps, base: string, scoped: ScopeOf): void {
  const id = (ctx: RequestContext) => ctx.params.id ?? "";
  const body = async (ctx: RequestContext) => (await readJson(ctx.req)) as Record<string, unknown>;
  const record = (s: Scope, action: string, target: string, detail: unknown) => audit(deps, { actor: s.actor, orgId: s.orgId, action, target, detail });

  router.get(`${base}/channels`, scoped(async (s) => json(await listChannels(deps, s.orgId)), false));
  router.post(`${base}/channels`, scoped(async (s, ctx) => {
    const out = await createChannel(deps, s.orgId, s.userId, await body(ctx));
    await record(s, "alert.channel.create", out.id, { kind: out.kind, name: out.name });
    return json(out, 201);
  }, true));
  router.patch(`${base}/channels/:id`, scoped(async (s, ctx) => {
    const b = await body(ctx);
    const out = await updateChannel(deps, s.orgId, id(ctx), b);
    await record(s, "alert.channel.update", out.id, { name: out.name, config_changed: b.config !== undefined });
    return json(out);
  }, true));
  router.delete(`${base}/channels/:id`, scoped(async (s, ctx) => {
    await deleteChannel(deps, s.orgId, id(ctx));
    await record(s, "alert.channel.delete", id(ctx), {});
    return noContent();
  }, true));
  router.post(`${base}/channels/:id/test`, withRetryAfter(scoped(async (s, ctx) => {
    const { kind, ...out } = await testChannel(deps, s.orgId, id(ctx));
    await record(s, "alert.channel.test", id(ctx), { kind, status: out.status });
    return json(out);
  }, true)));

  router.get(`${base}/rules`, scoped(async (s) => json(await listRules(deps, s.orgId)), false));
  router.post(`${base}/rules`, scoped(async (s, ctx) => {
    const out = await createRule(deps, s.orgId, s.userId, await body(ctx), s.appId);
    await record(s, "alert.rule.create", out?.id ?? "", { kind: out?.kind, app: out?.app, channels: out?.channels });
    return json(out, 201);
  }, true));
  router.patch(`${base}/rules/:id`, scoped(async (s, ctx) => {
    const b = await body(ctx);
    const out = await updateRule(deps, s.orgId, id(ctx), b);
    await record(s, "alert.rule.update", id(ctx), { fields: Object.keys(b), enabled: out?.enabled, channels: out?.channels });
    return json(out);
  }, true));
  router.delete(`${base}/rules/:id`, scoped(async (s, ctx) => {
    await deleteRule(deps, s.orgId, id(ctx));
    await record(s, "alert.rule.delete", id(ctx), {});
    return noContent();
  }, true));

  router.get(`${base}/active`, scoped(async (s) => json(await activeAlerts(deps, s.orgId)), false));
}

export function registerAlerts(router: Router, deps: Deps): void {
  const orgScope: ScopeOf = (h, write) =>
    withRetryAfter(
      requireSession(deps, async (ctx) => {
        const { user } = authOf(ctx);
        const access: OrgAccess = await orgAccess(deps, user, ctx.params.org ?? "", write ? "alert.write" : "alert.read");
        const appId = async (slug: string) => {
          const c: A.OrgCtx = { deps, org: access.org, sub: access.subject, actor: access.actor, cli: await A.orgClient(deps, access.org) };
          return (await A.appFor(c, slug, "app.read")).id;
        };
        return h({ orgId: access.org.id, userId: user.id, actor: access.actor, appId }, ctx);
      }),
    );
  const instanceScope: ScopeOf = (h) =>
    withRetryAfter(
      requireAdmin(deps, async (ctx) => {
        const { user } = authOf(ctx);
        return h({ orgId: null, userId: user.id, actor: { userId: user.id }, appId: noApps }, ctx);
      }),
    );
  routes(router, deps, "/api/orgs/:org/alerts", orgScope);
  routes(router, deps, "/api/admin/alerts", instanceScope);
}
