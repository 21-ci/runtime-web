// Request guards: session, CSRF, Origin, must-change-password and policy gates. Use from any route module:
//
//   r.get("/api/orgs", requireSession(deps, async (ctx) => { const { user } = authOf(ctx); ... }));
//   r.post("/api/admin/users", requireAdmin(deps, handler));
//
// requireSession order (api-web §1.2): session (401) → must-change-password gate →
// 2FA-enrollment gate → CSRF on unsafe methods (403 csrf_invalid) → instance admin.
// The Origin check is global middleware (originCheck), installed by registerAuth.

import { constantTimeEqual } from "../crypto/hash.ts";
import { AppError, forbidden } from "../http/errors.ts";
import type { Handler, Middleware, RequestContext } from "../http/router.ts";
import { getPolicy } from "./policy.ts";
import { lookupSession, sessionCookie } from "./session.ts";
import { totpEnabled } from "./totp.ts";
import { dbOf, type AuthDeps, type Session, type SessionUser } from "./types.ts";

export type { Session, SessionUser } from "./types.ts";

export const CSRF_HEADER = "x-csrf-token";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
export const isSafeMethod = (m: string) => SAFE.has(m.toUpperCase());

export const unauthenticated = () => new AppError(401, "unauthenticated", "sign in required");

/** Paths exempt from the must-change-password gate. */
const PASSWORD_GATE_EXEMPT = ["/api/me", "/api/me/password", "/api/auth/logout"];
/** Paths exempt from the 2FA-enrollment gate; "/*" matches the prefix and below. */
const MFA_GATE_EXEMPT = ["/api/me", "/api/me/totp/*", "/api/auth/logout"];

export function pathAllowed(path: string, allow: readonly string[]): boolean {
  return allow.some((a) => {
    if (a.endsWith("/*")) {
      const p = a.slice(0, -2);
      return path === p || path.startsWith(`${p}/`);
    }
    return path === a;
  });
}

/** scheme://host[:port] lower-cased, or "" when raw is not an absolute URL. */
export function normalizeOrigin(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    const u = new URL(raw.trim());
    if (!u.host || u.origin === "null") return "";
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}`;
  } catch {
    return "";
  }
}

/**
 * Global middleware: every unsafe method must carry Origin == config.origin
 * (403 origin_invalid), public routes included. `exempt` paths (bearer-authed
 * internal routes) skip it.
 */
export function originCheck(deps: Pick<AuthDeps, "config">, exempt: readonly string[] = ["/api/internal/*"]): Middleware {
  const want = normalizeOrigin(deps.config.origin);
  return async (ctx, next) => {
    if (isSafeMethod(ctx.req.method) || pathAllowed(ctx.url.pathname, exempt)) return next();
    const got = normalizeOrigin(ctx.req.headers.get("origin"));
    if (!want || got !== want) throw forbidden("origin_invalid", "request origin not allowed");
    return next();
  };
}

export interface AuthState {
  user: SessionUser;
  session: Session;
}

/** The caller set by requireSession. Throws 401 if the handler was not wrapped. */
export function authOf(ctx: RequestContext): AuthState {
  const user = ctx.state.user as SessionUser | undefined;
  const session = ctx.state.session as Session | undefined;
  if (!user || !session) throw unauthenticated();
  return { user, session };
}

export interface SessionOpts {
  /** Instance admins only (403 forbidden otherwise). */
  admin?: boolean;
}

/** Loads the session into ctx.state (or 401) without the gates; for gate-exempt helpers and tests. */
export async function loadSession(deps: AuthDeps, ctx: RequestContext): Promise<AuthState> {
  const cookie = sessionCookie(deps.config, ctx.req);
  const db = await dbOf(deps);
  const found = cookie ? await lookupSession(db, deps.now(), cookie) : null;
  if (!found) throw unauthenticated();
  ctx.state.user = found.user;
  ctx.state.session = found.session;
  return found;
}

/** Wraps h with the full session chain. */
export function requireSession(deps: AuthDeps, h: Handler, opts: SessionOpts = {}): Handler {
  return async (ctx) => {
    const { user, session } = await loadSession(deps, ctx);
    const path = ctx.url.pathname;
    if (user.mustChangePassword && !pathAllowed(path, PASSWORD_GATE_EXEMPT)) {
      throw forbidden("password_change_required", "change your password to continue");
    }
    if (!pathAllowed(path, MFA_GATE_EXEMPT)) {
      const db = await dbOf(deps);
      if ((await getPolicy(db)).require2fa && !(await totpEnabled(db, user.id))) {
        throw forbidden("mfa_enrollment_required", "two-factor authentication must be set up");
      }
    }
    if (!isSafeMethod(ctx.req.method)) {
      const got = ctx.req.headers.get(CSRF_HEADER) ?? "";
      if (!session.csrf || !got || !constantTimeEqual(got, session.csrf)) {
        throw forbidden("csrf_invalid", "missing or invalid CSRF token");
      }
    }
    if (opts.admin && !user.instanceAdmin) throw forbidden("forbidden", "instance admin required");
    return h(ctx);
  };
}

/** requireSession + instance admin. */
export const requireAdmin = (deps: AuthDeps, h: Handler): Handler => requireSession(deps, h, { admin: true });

/** Adds `Retry-After` to 429/503 AppErrors that carry details.retry_after. */
export function withRetryAfter(h: Handler): Handler {
  return async (ctx) => {
    try {
      return await h(ctx);
    } catch (err) {
      if (err instanceof AppError && (err.status === 429 || err.status === 503) && typeof err.details?.retry_after === "number") {
        const body = { error: { code: err.code, message: err.message, details: err.details } };
        return new Response(JSON.stringify(body), {
          status: err.status,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "retry-after": String(err.details.retry_after),
          },
        });
      }
      throw err;
    }
  };
}

/** Alias for other tasks: the signed-in user (ctx.state.user). */
export type CurrentUser = SessionUser;
