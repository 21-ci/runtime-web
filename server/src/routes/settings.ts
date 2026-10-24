// Instance settings (api-web §6): public URL, 2FA and password-login policy, and the
// OAuth/OIDC providers. Storage and validation of providers live in auth/oauth.ts and
// the policy in auth/policy.ts; this route validates the request shape and batches
// everything with its audit row.

import type { Deps } from "../app.ts";
import { auditStmt } from "../audit/audit.ts";
import { requireAdmin, withRetryAfter, authOf } from "../auth/middleware.ts";
import { getPolicy, setPolicy } from "../auth/policy.ts";
import { oauthSettings, oauthSettingStatements, ssoConfigured, type ProviderInput } from "../auth/oauth.ts";
import { dbOf } from "../auth/types.ts";
import { AppError, invalid } from "../http/errors.ts";
import { json, readJson } from "../http/json.ts";
import type { Router } from "../http/router.ts";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Parses the providers array; field errors are keyed providers[i].<field>. */
function parseProviders(raw: unknown, fields: Record<string, string>): ProviderInput[] | undefined {
  if (!Array.isArray(raw)) {
    fields.providers = "must_be_array";
    return undefined;
  }
  const out: ProviderInput[] = [];
  raw.forEach((p, i) => {
    if (!isObj(p)) {
      fields[`providers[${i}]`] = "must_be_object";
      return;
    }
    if (typeof p.id !== "string") fields[`providers[${i}].id`] = "required";
    if (typeof p.enabled !== "boolean") fields[`providers[${i}].enabled`] = "must_be_boolean";
    if (typeof p.client_id !== "string") fields[`providers[${i}].client_id`] = "must_be_string";
    for (const k of ["client_secret", "issuer", "name"] as const) {
      if (p[k] !== undefined && typeof p[k] !== "string") fields[`providers[${i}].${k}`] = "must_be_string";
    }
    if (typeof p.id === "string" && typeof p.enabled === "boolean" && typeof p.client_id === "string") {
      const item: ProviderInput = { id: p.id, enabled: p.enabled, client_id: p.client_id };
      if (typeof p.client_secret === "string") item.client_secret = p.client_secret;
      if (typeof p.issuer === "string") item.issuer = p.issuer;
      if (typeof p.name === "string") item.name = p.name;
      out.push(item);
    }
  });
  return out;
}

async function view(deps: Deps) {
  const db = await dbOf(deps);
  const pol = await getPolicy(db);
  const providers = await oauthSettings(deps);
  return {
    public_url: deps.config.origin,
    require_2fa: pol.require2fa,
    password_login_disabled: pol.passwordLoginDisabled,
    providers: providers.map((p) => ({
      id: p.id,
      enabled: p.enabled,
      client_id: p.client_id,
      client_secret_set: p.secret_set,
      ...(p.issuer ? { issuer: p.issuer } : {}),
      ...(p.name ? { name: p.name } : {}),
    })),
  };
}

export function registerSettings(r: Router, deps: Deps): void {
  r.get(
    "/api/admin/settings",
    requireAdmin(
      deps,
      withRetryAfter(async () => json(await view(deps))),
    ),
  );

  r.put(
    "/api/admin/settings",
    requireAdmin(
      deps,
      withRetryAfter(async (ctx) => {
        const { user } = authOf(ctx);
        const body = await readJson<Record<string, unknown>>(ctx.req);
        const fields: Record<string, string> = {};
        const db = await dbOf(deps);
        const cur = await getPolicy(db);
        let require2fa = cur.require2fa;
        let passwordLoginDisabled = cur.passwordLoginDisabled;
        if (body.require_2fa !== undefined) {
          if (typeof body.require_2fa === "boolean") require2fa = body.require_2fa;
          else fields.require_2fa = "must_be_boolean";
        }
        if (body.password_login_disabled !== undefined) {
          if (typeof body.password_login_disabled === "boolean") passwordLoginDisabled = body.password_login_disabled;
          else fields.password_login_disabled = "must_be_boolean";
        }
        const providers = body.providers !== undefined ? parseProviders(body.providers, fields) : undefined;
        if (Object.keys(fields).length > 0) throw invalid(fields);

        const oauth = providers ? await oauthSettingStatements(deps, providers) : { stmts: [], ssoOk: await ssoConfigured(deps) };
        const audit = auditStmt(deps, {
          actor: { userId: user.id, asInstanceAdmin: true },
          action: "settings.update",
          target: "instance",
          detail: {
            require_2fa: require2fa,
            password_login_disabled: passwordLoginDisabled,
            providers: (providers ?? []).map((p) => ({ id: p.id, enabled: p.enabled })),
          },
        });
        try {
          await setPolicy(db, { require2fa, passwordLoginDisabled }, oauth.ssoOk, [...oauth.stmts, audit]);
        } catch (e) {
          if (e instanceof AppError && e.code === "sso_not_configured") {
            throw invalid({ password_login_disabled: "sso_not_configured" });
          }
          throw e;
        }
        return json(await view(deps));
      }),
    ),
  );
}
