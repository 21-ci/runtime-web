// OAuth login linking (api-web §4). Failures redirect to /login?error=<code>.

import type { Deps } from "../app.ts";
import { oauthCallback, oauthStart } from "../auth/oauth.ts";
import { authOf, requireSession } from "../auth/middleware.ts";
import { setSessionCookie } from "../auth/session.ts";
import { json, readJson } from "../http/json.ts";
import type { Router } from "../http/router.ts";
import { clientOf } from "./auth.ts";

function redirect(location: string, cookies: string[]): Response {
  const h = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
}

export function registerOAuth(r: Router, deps: Deps): void {
  r.get("/api/auth/oauth/:provider/start", async (ctx) => {
    const out = await oauthStart(deps, ctx.params.provider ?? "", ctx.url.searchParams.get("next"));
    return redirect(out.location, [out.setCookie]);
  });

  // Linking is only possible from a signed-in session (never by matching email at login).
  r.post(
    "/api/me/oauth/:provider/link",
    requireSession(deps, async (ctx) => {
      const body = await readJson(ctx.req);
      const next = typeof body.next === "string" ? body.next : "/me/security";
      const out = await oauthStart(deps, ctx.params.provider ?? "", next, authOf(ctx).user.id);
      return json({ location: out.location }, 200, { "set-cookie": out.setCookie });
    }),
  );

  r.get("/api/auth/oauth/:provider/callback", async (ctx) => {
    const res = await oauthCallback(deps, ctx.params.provider ?? "", ctx.req, ctx.url, clientOf(ctx));
    const cookies = [res.clearStateCookie];
    if (res.outcome) cookies.push(setSessionCookie(deps.config, res.outcome.cookie));
    return redirect(`${ctx.basePath}${res.location}`, cookies);
  });
}
