// /api/auth/* (api-web §3): providers, login, MFA, logout. registerAuth also
// installs the global Origin check and the setup, /api/me* and OAuth routes.

import type { Deps } from "../app.ts";
import { completeMfa, login, type Client } from "../auth/login.ts";
import { originCheck, requireSession, authOf, withRetryAfter } from "../auth/middleware.ts";
import { listProviders } from "../auth/oauth.ts";
import { getPolicy } from "../auth/policy.ts";
import { clearSessionCookie, revokeSession, sessionCookie, setSessionCookie } from "../auth/session.ts";
import { totpEnabled } from "../auth/totp.ts";
import { dbOf, userJson, type SessionUser } from "../auth/types.ts";
import type { RequestContext, Router } from "../http/router.ts";
import { json, noContent, readJson } from "../http/json.ts";
import { registerMe } from "./me.ts";
import { registerOAuth } from "./oauth.ts";
import { registerSetup } from "./setup.ts";

export const clientOf = (ctx: RequestContext): Client => ({
  ip: ctx.clientIp ?? "",
  ua: (ctx.req.headers.get("user-agent") ?? "").slice(0, 512),
});

/** api-web SessionResp. */
export async function sessionResp(deps: Deps, user: SessionUser, csrf: string) {
  return { user: userJson(user, await totpEnabled(await dbOf(deps), user.id)), csrf };
}

export function registerAuth(r: Router, deps: Deps): void {
  r.use(originCheck(deps));
  registerSetup(r, deps);

  r.get("/api/auth/providers", async () => {
    const pol = await getPolicy(await dbOf(deps));
    return json({ password_login_disabled: pol.passwordLoginDisabled, providers: await listProviders(deps) });
  });

  r.post(
    "/api/auth/login",
    withRetryAfter(async (ctx) => {
      const body = await readJson(ctx.req);
      const out = await login(deps, body.email, body.password, clientOf(ctx));
      const headers = { "set-cookie": setSessionCookie(deps.config, out.cookie) };
      if (out.mfaRequired) return json({ mfa_required: true }, 200, headers);
      return json({ mfa_required: false, ...(await sessionResp(deps, out.user, out.csrf)) }, 200, headers);
    }),
  );

  r.post(
    "/api/auth/mfa",
    withRetryAfter(async (ctx) => {
      const body = await readJson(ctx.req);
      const out = await completeMfa(deps, sessionCookie(deps.config, ctx.req), body.code);
      return json(await sessionResp(deps, out.user, out.csrf), 200, { "set-cookie": setSessionCookie(deps.config, out.cookie) });
    }),
  );

  r.post(
    "/api/auth/logout",
    requireSession(deps, async (ctx) => {
      await revokeSession(await dbOf(deps), authOf(ctx).session.id);
      return noContent({ "set-cookie": clearSessionCookie(deps.config) });
    }),
  );

  registerMe(r, deps);
  registerOAuth(r, deps);
}
