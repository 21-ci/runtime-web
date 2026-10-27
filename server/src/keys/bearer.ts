// Custom tokens as `Authorization: Bearer <secret>` on the console API (review item 8).
//
// Only the app routes (/api/orgs/{org}/apps and below) accept a bearer; requireSession refuses
// it everywhere else with 403 bearer_not_allowed. A token acts in its own org only, with its
// scopes and projects mapped onto policy actions (authz/policy.ts TOKEN_SCOPE_FOR), and its
// environments enforced here before the handler runs. Bearer requests carry no cookie, so they
// skip CSRF and Origin; one that also carries a session cookie is refused.

import type { Deps } from "../app.ts";
import { rateLimited } from "../auth/ratelimit.ts";
import { dbOf, type AuthDeps, type Session, type SessionUser } from "../auth/types.ts";
import { sha256Hex } from "../crypto/hash.ts";
import { AppError, forbidden } from "../http/errors.ts";
import type { RequestContext } from "../http/router.ts";
import { Runtime } from "../runtime/client.ts";
import { defaultKey } from "../orgs/orgs.ts";

/** Requests one token may make per minute (fixed window in std:kv). */
export const TOKEN_REQUESTS_PER_MINUTE = 600;

/** The verified token behind a bearer request. */
export interface TokenPrincipal {
  id: string;
  orgId: string;
  name: string;
  scopes: string[];
  /** Project slugs; [] = every project. */
  projects: string[];
  /** Environment names; [] = every environment. */
  envs: string[];
}

/** The caller of a bearer request as seen by authOf: a synthetic user that carries the token. */
export type BearerUser = SessionUser & { token: TokenPrincipal };

const APP_PATH = /^\/api\/orgs\/([^/]+)\/apps(?:\/([^/]+)(?:\/.*)?)?\/?$/;

const invalidToken = () => new AppError(401, "unauthenticated", "invalid or expired token");

/** The secret of an `Authorization: Bearer` header ("" when empty), or null when there is none. */
export function bearerSecret(req: Request): string | null {
  const m = /^Bearer(?:\s+(.*))?$/i.exec((req.headers.get("authorization") ?? "").trim());
  return m ? (m[1] ?? "").trim() : null;
}

/** Whether path is one of the routes that accept a bearer token. */
export const bearerPathAllowed = (path: string): boolean => APP_PATH.test(path);

/** The token of a bearer caller, or undefined for a session user. */
export function bearerOf(user: SessionUser): TokenPrincipal | undefined {
  return (user as Partial<BearerUser>).token;
}

const decode = (s: string | undefined): string => {
  try {
    return decodeURIComponent(s ?? "");
  } catch {
    return "";
  }
};

/**
 * Verifies secret (sha256 against tokens.secret_hash; revoked, expired or unknown → 401),
 * applies the per-token rate limit and the project/environment gate, then puts the token
 * caller into ctx.state (user, session, token) the way requireSession does for a cookie.
 */
export async function authenticateBearer(
  deps: AuthDeps & Partial<Pick<Deps, "rtctl">>,
  ctx: RequestContext,
  secret: string,
): Promise<TokenPrincipal> {
  if (!secret) throw invalidToken();
  const db = await dbOf(deps);
  const row = await db.first<{ id: string; org_id: string; name: string; scopes: string; projects: string; envs: string; expires_at: number | null }>(
    "SELECT id, org_id, name, scopes, projects, envs, expires_at FROM tokens WHERE secret_hash = ? AND revoked_at IS NULL",
    [await sha256Hex(secret)],
  );
  const now = deps.now();
  if (!row || (row.expires_at !== null && row.expires_at <= now)) throw invalidToken();
  const t: TokenPrincipal = {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    scopes: JSON.parse(row.scopes) as string[],
    projects: JSON.parse(row.projects) as string[],
    envs: JSON.parse(row.envs) as string[],
  };
  const minute = Math.floor(now / 60_000);
  const n = await deps.storage.kv.incr(`rl:tok:${t.id}:${minute}`, 1, { ttlSeconds: 120 });
  if (n > TOKEN_REQUESTS_PER_MINUTE) throw rateLimited(Math.max(1, Math.ceil(((minute + 1) * 60_000 - now) / 1000)));
  await gate(deps, ctx, t);
  const user: BearerUser = {
    id: t.id,
    email: "",
    name: t.name,
    instanceAdmin: false,
    mustChangePassword: false,
    disabled: false,
    createdAt: 0,
    token: t,
  };
  const session: Session = { id: "", userId: t.id, csrf: "", createdAt: now, lastSeenAt: now, expiresAt: now, ip: ctx.clientIp ?? "", ua: "" };
  ctx.state.user = user;
  ctx.state.session = session;
  ctx.state.token = t;
  return t;
}

/**
 * Projects and environments the request names, checked against the token's lists (403 when
 * outside). The app's project and environment come from the runtime; a missing app or an org
 * other than the token's is left to the route (404).
 */
async function gate(deps: AuthDeps & Partial<Pick<Deps, "rtctl">>, ctx: RequestContext, t: TokenPrincipal): Promise<void> {
  if (t.projects.length === 0 && t.envs.length === 0) return;
  const m = APP_PATH.exec(ctx.url.pathname);
  if (!m) return;
  const outside = (project: string, env: string) => {
    if (t.projects.length > 0 && !t.projects.includes(project)) throw forbidden("forbidden", "project outside the token's projects");
    if (t.envs.length > 0 && !t.envs.includes(env)) throw forbidden("forbidden", "environment outside the token's environments");
  };
  const slug = decode(m[2]);
  if (slug) {
    const org = await (await dbOf(deps)).first<{ id: string; slug: string }>("SELECT id, slug FROM orgs WHERE id = ?", [t.orgId]);
    if (!deps.rtctl || !org || org.slug !== decode(m[1])) return;
    const cli = new Runtime(deps.rtctl).as(await defaultKey(deps, org.id));
    const svc = (await cli.listServices({ slug })).items.find((s) => s.slug === slug);
    if (svc) outside(svc.project, svc.environment);
    return;
  }
  if (ctx.req.method === "POST") {
    const b = (await ctx.req.clone().json().catch(() => ({}))) as Record<string, unknown>;
    outside(typeof b.project === "string" ? b.project : "", typeof b.environment === "string" ? b.environment : "");
    return;
  }
  // Listing: the route filters by project; an environment-restricted token must name one of its environments.
  if (t.envs.length > 0 && !t.envs.includes(ctx.url.searchParams.get("environment") ?? "")) {
    throw forbidden("forbidden", "pass ?environment= with one of the token's environments");
  }
}
