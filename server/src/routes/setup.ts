// First-run setup (api-web §3, design §5). The instance admin is created here;
// the first org (runtime tenant + hidden default key) is created right after it.

import type { Deps } from "../app.ts";
import { setup, setupNeeded } from "../auth/login.ts";
import { createSession, setSessionCookie } from "../auth/session.ts";
import { dbOf } from "../auth/types.ts";
import type { Router } from "../http/router.ts";
import { json, readJson } from "../http/json.ts";
import { clientOf, sessionResp } from "./auth.ts";
import { createFirstOrg } from "../orgs/orgs.ts";

export function registerSetup(r: Router, deps: Deps): void {
  r.get("/api/setup", async () => json({ needed: await setupNeeded(await dbOf(deps)) }));

  r.post("/api/setup", async (ctx) => {
    const body = await readJson(ctx.req);
    const user = await setup(deps, body);
    await createFirstOrg(deps, user.id);
    const c = clientOf(ctx);
    const s = await createSession(await dbOf(deps), deps.now(), user.id, c.ip, c.ua);
    return json(await sessionResp(deps, user, s.csrf), 201, { "set-cookie": setSessionCookie(deps.config, s.cookie) });
  });
}
