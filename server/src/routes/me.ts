// /api/me and account security (api-web §3, §5.1). Every handler acts on the
// caller's own user id only.

import type { Deps } from "../app.ts";
import { listLogins } from "../auth/events.ts";
import { changePassword } from "../auth/login.ts";
import { authOf, requireSession, withRetryAfter } from "../auth/middleware.ts";
import { getPolicy } from "../auth/policy.ts";
import { listSessions, revokeAllForUser, revokeByPublicId } from "../auth/session.ts";
import { confirm, disable, enroll, InvalidCodeError, regenerateRecoveryCodes } from "../auth/totp.ts";
import { dbOf } from "../auth/types.ts";
import { AppError, invalid } from "../http/errors.ts";
import type { Handler, Router } from "../http/router.ts";
import { json, noContent, readJson } from "../http/json.ts";
import { sessionResp } from "./auth.ts";

/** 422 invalid_code: the caller is signed in, so a wrong code is a bad field (api-web §1.5.1). */
function codeAs422(h: Handler): Handler {
  return async (ctx) => {
    try {
      return await h(ctx);
    } catch (err) {
      if (err instanceof InvalidCodeError) throw new AppError(422, "invalid_code", "invalid code");
      throw err;
    }
  };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function registerMe(r: Router, deps: Deps): void {
  const s = (h: Handler) => requireSession(deps, withRetryAfter(codeAs422(h)));

  r.get(
    "/api/me",
    s(async (ctx) => {
      const { user, session } = authOf(ctx);
      const db = await dbOf(deps);
      const base = await sessionResp(deps, user, session.csrf);
      const orgs = await db.all<{ slug: string; name: string; role: string }>(
        `SELECT o.slug, o.name, m.role FROM members m JOIN orgs o ON o.id = m.org_id
         WHERE m.user_id = ? AND o.deleted_at IS NULL ORDER BY o.name, o.slug`,
        [user.id],
      );
      const pol = await getPolicy(db);
      return json({
        ...base,
        orgs,
        policy: { require_2fa: pol.require2fa, password_login_disabled: pol.passwordLoginDisabled },
        mfa_enrollment_required: pol.require2fa && !base.user.totp_enabled,
      });
    }),
  );

  r.put(
    "/api/me/password",
    s(async (ctx) => {
      const { user, session } = authOf(ctx);
      const body = await readJson(ctx.req);
      await changePassword(deps, user.id, session.id, body.current_password, body.new_password);
      return noContent();
    }),
  );

  r.get(
    "/api/me/sessions",
    s(async (ctx) => {
      const { user, session } = authOf(ctx);
      return json({ items: await listSessions(await dbOf(deps), deps.now(), user.id, session.id) });
    }),
  );

  r.post(
    "/api/me/sessions/revoke-others",
    s(async (ctx) => {
      const { user, session } = authOf(ctx);
      const db = await dbOf(deps);
      const live = (await listSessions(db, deps.now(), user.id, session.id)).filter((x) => !x.current).length;
      await revokeAllForUser(db, user.id, session.id);
      return json({ revoked: live });
    }),
  );

  r.delete(
    "/api/me/sessions/:id",
    s(async (ctx) => {
      await revokeByPublicId(await dbOf(deps), authOf(ctx).user.id, ctx.params.id ?? "");
      return noContent();
    }),
  );

  r.post(
    "/api/me/totp/enroll",
    s(async (ctx) => {
      const body = await readJson(ctx.req);
      return json({ otpauth_url: await enroll(deps, authOf(ctx).user.id, str(body.password)) });
    }),
  );

  r.post(
    "/api/me/totp/confirm",
    s(async (ctx) => {
      const body = await readJson(ctx.req);
      return json({ recovery_codes: await confirm(deps, authOf(ctx).user.id, str(body.code)) });
    }),
  );

  r.post(
    "/api/me/totp/disable",
    s(async (ctx) => {
      const { user, session } = authOf(ctx);
      const body = await readJson(ctx.req);
      await disable(deps, user.id, session.id, str(body.password), str(body.code));
      return noContent();
    }),
  );

  r.post(
    "/api/me/recovery-codes",
    s(async (ctx) => {
      const body = await readJson(ctx.req);
      return json({ recovery_codes: await regenerateRecoveryCodes(deps, authOf(ctx).user.id, str(body.password)) });
    }),
  );

  r.get(
    "/api/me/logins",
    s(async (ctx) => {
      const raw = ctx.url.searchParams.get("limit");
      let limit = 50;
      if (raw !== null) {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 200) throw invalid({ limit: "out_of_range" });
        limit = n;
      }
      return json({ items: await listLogins(await dbOf(deps), authOf(ctx).user.id, limit) });
    }),
  );
}
