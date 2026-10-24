// Org custom tokens and default-key rotation (api-web §7).

import type { Deps } from "../app.ts";
import { authOf, requireSession } from "../auth/middleware.ts";
import { loadOrg, canOrg } from "../keys/access.ts";
import { createToken, listTokens, parseTokenReq, revokeToken, rotateDefaultKey } from "../keys/keys.ts";
import { forbidden } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { withRuntimeErrors } from "../keys/errors.ts";
import { json, noContent, readJson } from "../http/json.ts";

export function registerTokens(r: Router, deps: Deps): void {
  const s = (h: Parameters<typeof requireSession>[1]) => requireSession(deps, withRuntimeErrors(h));

  r.get(
    "/api/orgs/:org/tokens",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const { org, sub } = await loadOrg(deps, ctx.params.org as string, user);
      if (!canOrg(sub, "tokens.manage")) throw forbidden("forbidden", "not allowed");
      return json({ items: await listTokens(deps, org.id) });
    }),
  );

  r.post(
    "/api/orgs/:org/tokens",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const { org, sub } = await loadOrg(deps, ctx.params.org as string, user);
      if (!canOrg(sub, "tokens.manage")) throw forbidden("forbidden", "not allowed");
      const req = parseTokenReq(await readJson<unknown>(ctx.req), deps.now());
      const out = await createToken(deps, { id: user.id, name: user.name }, org, req);
      return json(out, 201);
    }),
  );

  r.delete(
    "/api/orgs/:org/tokens/:id",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const { org, sub } = await loadOrg(deps, ctx.params.org as string, user);
      if (!canOrg(sub, "tokens.manage")) throw forbidden("forbidden", "not allowed");
      await revokeToken(deps, { id: user.id, name: user.name }, org, ctx.params.id as string);
      return noContent();
    }),
  );

  r.post(
    "/api/orgs/:org/default-key/rotate",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const { org, sub } = await loadOrg(deps, ctx.params.org as string, user);
      if (!canOrg(sub, "defaultkey.rotate")) throw forbidden("forbidden", "not allowed");
      await rotateDefaultKey(deps, { id: user.id, name: user.name }, org);
      return noContent();
    }),
  );
}
