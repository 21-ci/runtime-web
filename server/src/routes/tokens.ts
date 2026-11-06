// Org custom tokens and default-key rotation (api-web §7).

import type { Deps } from "../app.ts";
import { authOf, requireSession } from "../auth/middleware.ts";
import { orgAccess } from "../orgs/members.ts";
import { createToken, listTokens, parseTokenReq, revokeToken, rotateDefaultKey } from "../keys/keys.ts";
import { audit } from "../audit/audit.ts";
import { csvLine, exportFileName, exportFormat, exportResponse, isoTime } from "../http/export.ts";
import type { Router } from "../http/router.ts";
import { withRuntimeErrors } from "../runtime/errors.ts";
import { json, noContent, readJson } from "../http/json.ts";

export function registerTokens(r: Router, deps: Deps): void {
  const s = (h: Parameters<typeof requireSession>[1]) => requireSession(deps, withRuntimeErrors(h));

  r.get(
    "/api/orgs/:org/tokens",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const format = exportFormat(ctx.url.searchParams, ["csv"] as const);
      const { org, actor } = await orgAccess(deps, user, ctx.params.org as string, "tokens.manage");
      const items = await listTokens(deps, org.id);
      if (!format) return json({ items });
      // The list holds no secret, so neither can the file.
      const res = await exportResponse({
        fileName: exportFileName([org.slug], "tokens", null, deps.now(), format),
        format,
        header: "name,scopes,projects,environments,created_by,created_at,expires_at,last_used_at",
        rows: items,
        line: (k) => csvLine([k.name, k.scopes.join(" "), k.projects.join(" "), k.environments.join(" "), k.created_by.name, isoTime(k.created_at), isoTime(k.expires_at), isoTime(k.last_used_at)]),
      });
      await audit(deps, { actor, orgId: org.id, action: "org.tokens.export", target: org.slug, detail: { format, rows: items.length } });
      return res;
    }),
  );

  r.post(
    "/api/orgs/:org/tokens",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const { org, actor } = await orgAccess(deps, user, ctx.params.org as string, "tokens.manage");
      const req = parseTokenReq(await readJson<unknown>(ctx.req), deps.now());
      const out = await createToken(deps, { id: user.id, name: user.name, asInstanceAdmin: actor.asInstanceAdmin === true }, org, req);
      return json(out, 201);
    }),
  );

  r.delete(
    "/api/orgs/:org/tokens/:id",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const { org, actor } = await orgAccess(deps, user, ctx.params.org as string, "tokens.manage");
      await revokeToken(deps, { id: user.id, name: user.name, asInstanceAdmin: actor.asInstanceAdmin === true }, org, ctx.params.id as string);
      return noContent();
    }),
  );

  r.post(
    "/api/orgs/:org/default-key/rotate",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const { org, actor } = await orgAccess(deps, user, ctx.params.org as string, "defaultkey.rotate");
      await rotateDefaultKey(deps, { id: user.id, name: user.name, asInstanceAdmin: actor.asInstanceAdmin === true }, org);
      return noContent();
    }),
  );
}
