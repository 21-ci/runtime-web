// Invites (api-web §5.2): org-scoped management, instance-admin management, public accept.

import type { Deps } from "../app.ts";
import { loginUser } from "../auth/login.ts";
import { authOf, loadSession, requireAdmin, requireSession } from "../auth/middleware.ts";
import { setSessionCookie } from "../auth/session.ts";
import { dbOf } from "../auth/types.ts";
import { AppError, notFound } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { json, noContent, readJson } from "../http/json.ts";
import { acceptInvite, createInvite, listInvites, previewInvite, revokeInvite } from "../invites/invites.ts";
import { orgAccess } from "../orgs/members.ts";
import { getOrgBySlug } from "../orgs/orgs.ts";
import { clientOf } from "./auth.ts";

export function registerInvites(r: Router, deps: Deps): void {
  const s = (h: Parameters<typeof requireSession>[1]) => requireSession(deps, h);
  const a = (h: Parameters<typeof requireAdmin>[1]) => requireAdmin(deps, h);

  r.get(
    "/api/orgs/:org/invites",
    s(async (ctx) => {
      const acc = await orgAccess(deps, authOf(ctx).user, ctx.params.org as string, "invites.manage");
      return json({ items: await listInvites(deps, acc.org.id) });
    }),
  );
  r.post(
    "/api/orgs/:org/invites",
    s(async (ctx) => {
      const acc = await orgAccess(deps, authOf(ctx).user, ctx.params.org as string);
      return json(await createInvite(deps, acc.actor, acc.subject, acc.org.id, await readJson(ctx.req)), 201);
    }),
  );
  r.delete(
    "/api/orgs/:org/invites/:id",
    s(async (ctx) => {
      const acc = await orgAccess(deps, authOf(ctx).user, ctx.params.org as string);
      await revokeInvite(deps, acc.actor, acc.subject, acc.org.id, ctx.params.id as string);
      return noContent();
    }),
  );

  const adminSubject = (ctx: Parameters<Parameters<typeof requireAdmin>[1]>[0]) => {
    const { user } = authOf(ctx);
    return { actor: { userId: user.id }, subject: { userId: user.id, instanceAdmin: true } };
  };
  r.get(
    "/api/admin/invites",
    a(async (ctx) => json({ items: await listInvites(deps, null, ctx.url.searchParams.get("org")) })),
  );
  r.post(
    "/api/admin/invites",
    a(async (ctx) => {
      const body = await readJson(ctx.req);
      let orgId: string | null = null;
      if (body.org !== undefined && body.org !== null && body.org !== "") {
        const o = typeof body.org === "string" ? await getOrgBySlug(await dbOf(deps), body.org) : null;
        if (!o) throw notFound();
        orgId = o.id;
      }
      const { actor, subject } = adminSubject(ctx);
      return json(await createInvite(deps, actor, subject, orgId, body), 201);
    }),
  );
  r.delete(
    "/api/admin/invites/:id",
    a(async (ctx) => {
      const { actor, subject } = adminSubject(ctx);
      await revokeInvite(deps, actor, subject, null, ctx.params.id as string);
      return noContent();
    }),
  );

  r.get("/api/invites/accept/:token", async (ctx) => json(await previewInvite(deps, ctx.params.token as string)));

  // Public (Origin enforced globally); the single-use token replaces CSRF.
  r.post("/api/invites/accept/:token", async (ctx) => {
    let callerId: string | null = null;
    try {
      callerId = (await loadSession(deps, ctx)).user.id;
    } catch (e) {
      if (!(e instanceof AppError && e.status === 401)) throw e;
    }
    const body = await readJson(ctx.req).catch(() => ({}) as Record<string, unknown>);
    const out = await acceptInvite(deps, ctx.params.token as string, callerId, body);
    if (out.existing) return json({ email: out.email, mfa_required: false });
    const login = await loginUser(deps, out.userId, "invite", clientOf(ctx));
    const headers = { "set-cookie": setSessionCookie(deps.config, login.cookie) };
    if (login.mfaRequired) return json({ email: out.email, mfa_required: true }, 200, headers);
    return json({ email: out.email, mfa_required: false, csrf: login.csrf }, 200, headers);
  });
}
