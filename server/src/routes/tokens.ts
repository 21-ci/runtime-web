// Org custom tokens and default-key rotation (api-web §7).

import type { Deps } from "../app.ts";
import { authOf, requireSession } from "../auth/middleware.ts";
import { orgAccess } from "../orgs/members.ts";
import { createToken, listTokens, parseTokenReq, revokeToken, rotateDefaultKey } from "../keys/keys.ts";
import type { Router } from "../http/router.ts";
import { withRuntimeErrors } from "../runtime/errors.ts";
import { json, noContent, readJson } from "../http/json.ts";

export function registerTokens(r: Router, deps: Deps): void {
  const s = (h: Parameters<typeof requireSession>[1]) => requireSession(deps, withRuntimeErrors(h));

  r.get(
    "/api/orgs/:org/tokens",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const { org } = await orgAccess(deps, user, ctx.params.org as string, "tokens.manage");
      return json({ items: await listTokens(deps, org.id) });
    }),
  );

  r.post(
    "/api/orgs/:org/tokens",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const { org } = await orgAccess(deps, user, ctx.params.org as string, "tokens.manage");
      const req = parseTokenReq(await readJson<unknown>(ctx.req), deps.now());
      const out = await createToken(deps, { id: user.id, name: user.name }, org, req);
      return json(out, 201);
    }),
  );

  r.delete(
    "/api/orgs/:org/tokens/:id",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const { org } = await orgAccess(deps, user, ctx.params.org as string, "tokens.manage");
      await revokeToken(deps, { id: user.id, name: user.name }, org, ctx.params.id as string);
      return noContent();
    }),
  );

  r.post(
    "/api/orgs/:org/default-key/rotate",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const { org } = await orgAccess(deps, user, ctx.params.org as string, "defaultkey.rotate");
      await rotateDefaultKey(deps, { id: user.id, name: user.name }, org);
      return noContent();
    }),
  );
}
