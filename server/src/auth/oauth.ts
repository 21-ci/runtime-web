// OAuth / OIDC login linking.
// Authorization code + PKCE (S256) with a confidential client. It only links an
// existing user by verified email and never creates one. id_token/nonce are not
// used: identity comes from userinfo (GitHub: /user + /user/emails) over TLS.
//
// State: a random `state` goes in the `__Host-rtw_oauth` cookie (binds the
// browser) and keys `oauth:<state>` in KV (TTL 600 s) holding verifier, provider
// and next. Both are single use.
//
// Issuers must be https (http only with insecure cookies, i.e. local dev), the
// discovery document must report the configured issuer and https endpoints, and
// literal private/loopback/link-local hosts are rejected. Hostnames are not
// resolved here: the runtime's egress guard refuses private addresses at fetch.

import { constantTimeEqual, sha256 } from "../crypto/hash.ts";
import { base64url, randomToken } from "../crypto/random.ts";
import { clearCookie, getCookie, oauthStateCookieName, setCookie } from "../http/cookies.ts";
import { AppError, conflict, invalid, notFound } from "../http/errors.ts";
import type { Db, Stmt } from "../storage/types.ts";
import { loginUser, type Client, type LoginOutcome } from "./login.ts";
import { lookupSession, sessionCookie } from "./session.ts";
import { dbOf, getUserByEmail, normalizeEmail, sealerOf, type AuthDeps } from "./types.ts";

export const PROVIDERS = ["github", "google", "oidc"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const OAUTH_STATE_TTL_SECONDS = 600;
const DISCOVERY_TTL_MS = 10 * 60_000;
const DISCOVERY_MAX = 64;

export const GITHUB_WEB = "https://github.com";
export const GITHUB_API = "https://api.github.com";
export const GOOGLE_ISSUER = "https://accounts.google.com";

export type OAuthErrorCode =
  | "oauth_state_invalid"
  | "email_unverified"
  | "no_account"
  | "link_required"
  | "identity_taken"
  | "account_disabled"
  | "oauth_failed";

const isProvider = (id: string): id is ProviderId => (PROVIDERS as readonly string[]).includes(id);
const settingKey = (id: string) => `oauth.${id}`;
const secretKey = (id: string) => `oauth.${id}.client_secret`;

interface StoredProvider {
  enabled: boolean;
  client_id: string;
  issuer?: string;
  name?: string;
}

export interface ProviderConfig {
  id: ProviderId;
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  issuer: string;
  name: string;
}

/** Admin view of one provider; the secret is never returned. */
export interface ProviderSetting {
  id: ProviderId;
  enabled: boolean;
  client_id: string;
  issuer: string;
  name: string;
  secret_set: boolean;
}

async function setting<T>(db: Db, key: string): Promise<T | null> {
  const r = await db.first<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]);
  if (!r) return null;
  return JSON.parse(r.value) as T;
}

/** Every known provider for the admin settings view. */
export async function oauthSettings(deps: AuthDeps): Promise<ProviderSetting[]> {
  const db = await dbOf(deps);
  const out: ProviderSetting[] = [];
  for (const id of PROVIDERS) {
    const sp = await setting<StoredProvider>(db, settingKey(id));
    const sec = await setting<string>(db, secretKey(id));
    out.push({
      id,
      enabled: sp?.enabled ?? false,
      client_id: sp?.client_id ?? "",
      issuer: sp?.issuer ?? "",
      name: sp?.name ?? "",
      secret_set: sec !== null,
    });
  }
  return out;
}

export interface ProviderInput {
  id: string;
  enabled: boolean;
  client_id: string;
  /** Empty or absent keeps the stored secret. */
  client_secret?: string;
  issuer?: string;
  name?: string;
}

/** Whether an enabled provider with a secret exists (needed to disable password login). */
export async function ssoConfigured(deps: AuthDeps): Promise<boolean> {
  return (await oauthSettings(deps)).some((p) => p.enabled && p.secret_set);
}

/**
 * Validates providers and returns the statements that store them (secrets
 * sealed), plus whether SSO would be usable afterwards. Nothing is written:
 * the caller batches these with the policy and its audit row.
 */
export async function oauthSettingStatements(deps: AuthDeps, input: ProviderInput[]): Promise<{ stmts: Stmt[]; ssoOk: boolean }> {
  const current = new Map((await oauthSettings(deps)).map((p) => [p.id, p]));
  const up = "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
  const stmts: Stmt[] = [];
  for (const [i, p] of input.entries()) {
    if (!isProvider(p.id)) throw invalid({ [`providers[${i}].id`]: "not_one_of" });
    if (p.id === "oidc" && p.enabled && !validUrl(p.issuer ?? "", deps.config.insecureCookies)) {
      throw invalid({ [`providers[${i}].issuer`]: "invalid_format" });
    }
    const sp: StoredProvider = { enabled: p.enabled, client_id: p.client_id };
    if (p.issuer) sp.issuer = p.issuer;
    if (p.name) sp.name = p.name;
    stmts.push({ sql: up, args: [settingKey(p.id), JSON.stringify(sp)] });
    const cur = current.get(p.id);
    if (cur) {
      cur.enabled = p.enabled;
      if (p.client_secret) cur.secret_set = true;
    }
    if (p.client_secret) {
      const sealed = await (await sealerOf(deps)).seal(new TextEncoder().encode(p.client_secret));
      stmts.push({ sql: up, args: [secretKey(p.id), JSON.stringify(base64url(sealed))] });
    }
  }
  return { stmts, ssoOk: [...current.values()].some((p) => p.enabled && p.secret_set) };
}

/** Convenience: stores one provider immediately. */
export async function setProvider(deps: AuthDeps, p: ProviderInput): Promise<void> {
  const { stmts } = await oauthSettingStatements(deps, [p]);
  await (await dbOf(deps)).batch(stmts);
}

function unb64url(s: string): Uint8Array {
  const b = s.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(b + "=".repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

/** An enabled, fully configured provider with its secret, or null. */
export async function getProvider(deps: AuthDeps, id: string): Promise<ProviderConfig | null> {
  if (!isProvider(id)) return null;
  const db = await dbOf(deps);
  const sp = await setting<StoredProvider>(db, settingKey(id));
  if (!sp?.enabled) return null;
  const sec = await setting<string>(db, secretKey(id));
  if (sec === null) return null;
  const plain = await (await sealerOf(deps)).open(unb64url(sec));
  return {
    id,
    enabled: true,
    clientId: sp.client_id,
    clientSecret: new TextDecoder().decode(plain),
    issuer: sp.issuer ?? "",
    name: sp.name ?? "",
  };
}

/** Enabled providers for the login page, fixed order. */
export async function listProviders(deps: AuthDeps): Promise<{ id: ProviderId; name: string }[]> {
  const out: { id: ProviderId; name: string }[] = [];
  for (const id of PROVIDERS) {
    const p = await getProvider(deps, id);
    if (!p) continue;
    const name = id === "github" ? "GitHub" : id === "google" ? "Google" : p.name || "SSO";
    out.push({ id, name });
  }
  return out;
}

const SAFE_PATH = /^\/(?![/\\])[\x21-\x7e]*$/;

/**
 * Keeps only same-origin absolute paths, defaulting to "/". Both the raw value and its
 * percent-decoded form must be "/" plus printable ASCII, not start with "//" or "/\\",
 * and contain no backslash: browsers drop tabs/newlines and treat "\\" as "/", so
 * "/\t/evil.com" would otherwise become "//evil.com" (audit M7).
 */
export function safeNext(p: string | null | undefined): string {
  if (!p) return "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    return "/";
  }
  for (const v of [p, decoded]) if (!SAFE_PATH.test(v) || v.includes("\\")) return "/";
  return p;
}

/** Absolute https URL (http only in dev). */
export function validUrl(raw: string, dev: boolean): boolean {
  try {
    const u = new URL(raw);
    if (!u.hostname) return false;
    return u.protocol === "https:" || (dev && u.protocol === "http:");
  } catch {
    return false;
  }
}

/** True for loopback, private, link-local, unspecified, multicast and CGNAT literals, and localhost names. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(":")) {
    if (h === "::" || h === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return isPrivateHost(mapped[1] as string);
    const first = parseInt(h.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return false;
}

interface Endpoints {
  auth: string;
  token: string;
  userinfo: string;
}

const discoveryCache = new Map<string, { ep: Endpoints; at: number }>();

/** Clears the per-isolate discovery cache (tests). */
export const resetDiscoveryCache = () => discoveryCache.clear();

const fetchOf = (deps: AuthDeps): typeof fetch => deps.fetch ?? globalThis.fetch.bind(globalThis);

async function getJson<T>(deps: AuthDeps, url: string, bearer?: string): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetchOf(deps)(url, { headers, redirect: "error" });
  if (!res.ok) throw new Error(`oauth: GET ${new URL(url).host}: ${res.status}`);
  return (await res.json()) as T;
}

async function discover(deps: AuthDeps, issuerIn: string): Promise<Endpoints> {
  const dev = deps.config.insecureCookies;
  const issuer = issuerIn.replace(/\/+$/, "");
  if (!validUrl(issuer, dev)) throw new Error("oauth: issuer must be https");
  const now = deps.now();
  const c = discoveryCache.get(issuer);
  if (c && now - c.at < DISCOVERY_TTL_MS) return c.ep;
  if (!dev && isPrivateHost(new URL(issuer).hostname)) throw new Error("oauth: issuer host is not public");
  const doc = await getJson<{ issuer?: string; authorization_endpoint?: string; token_endpoint?: string; userinfo_endpoint?: string }>(
    deps,
    `${issuer}/.well-known/openid-configuration`,
  );
  if ((doc.issuer ?? "").replace(/\/+$/, "") !== issuer) throw new Error("oauth: discovery issuer mismatch");
  const ep = { auth: doc.authorization_endpoint ?? "", token: doc.token_endpoint ?? "", userinfo: doc.userinfo_endpoint ?? "" };
  for (const u of [ep.auth, ep.token, ep.userinfo]) {
    if (!validUrl(u, dev)) throw new Error("oauth: discovery endpoint must be https");
    if (!dev && isPrivateHost(new URL(u).hostname)) throw new Error("oauth: discovery endpoint host is not public");
  }
  if (!discoveryCache.has(issuer) && discoveryCache.size >= DISCOVERY_MAX) {
    const oldest = [...discoveryCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) discoveryCache.delete(oldest[0]);
  }
  discoveryCache.set(issuer, { ep, at: now });
  return ep;
}

async function endpointsFor(deps: AuthDeps, p: ProviderConfig): Promise<Endpoints> {
  if (p.id === "github") {
    return { auth: `${GITHUB_WEB}/login/oauth/authorize`, token: `${GITHUB_WEB}/login/oauth/access_token`, userinfo: `${GITHUB_API}/user` };
  }
  return discover(deps, p.id === "google" ? GOOGLE_ISSUER : p.issuer);
}

const redirectUri = (deps: AuthDeps, id: string) => `${deps.config.origin}/api/auth/oauth/${id}/callback`;
const cookieMode = (deps: AuthDeps) => ({ insecure: deps.config.insecureCookies });

interface StoredState {
  verifier: string;
  provider: ProviderId;
  next: string;
  /** Set when a signed-in user links this provider (POST /api/me/oauth/{p}/link). */
  linkUser?: string;
}

/**
 * Builds the provider URL and the state cookie. Unconfigured providers are 404.
 * With linkUser the callback attaches the identity to that user instead of signing in.
 */
export async function oauthStart(
  deps: AuthDeps,
  providerId: string,
  next: string | null,
  linkUser?: string,
): Promise<{ location: string; setCookie: string }> {
  const p = await getProvider(deps, providerId);
  if (!p) throw notFound();
  const ep = await endpointsFor(deps, p);
  const state = randomToken(32);
  const verifier = randomToken(32);
  const st: StoredState = { verifier, provider: p.id, next: safeNext(next), ...(linkUser ? { linkUser } : {}) };
  await deps.storage.kv.set(`oauth:${state}`, st, { ttlSeconds: OAUTH_STATE_TTL_SECONDS });
  const q = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: redirectUri(deps, p.id),
    state,
    code_challenge: base64url(await sha256(verifier)),
    code_challenge_method: "S256",
    scope: p.id === "github" ? "read:user user:email" : "openid email",
  });
  return {
    location: `${ep.auth}?${q.toString()}`,
    setCookie: setCookie(oauthStateCookieName(cookieMode(deps)), state, {
      ...cookieMode(deps),
      maxAgeSeconds: OAUTH_STATE_TTL_SECONDS,
    }),
  };
}

export interface CallbackResult {
  /** Path to redirect to: next, /login/mfa or /login?error=<code>. */
  location: string;
  /** Set-Cookie headers: state cookie cleared, plus the session cookie on success. */
  outcome: LoginOutcome | null;
  clearStateCookie: string;
}

const loginError = (code: OAuthErrorCode) => `/login?error=${code}`;

/** Handles the provider callback. Only storage faults throw; everything else is a redirect. */
export async function oauthCallback(deps: AuthDeps, providerId: string, req: Request, url: URL, client: Client): Promise<CallbackResult> {
  const clearStateCookie = clearCookie(oauthStateCookieName(cookieMode(deps)), cookieMode(deps));
  const done = (location: string, outcome: LoginOutcome | null = null): CallbackResult => ({ location, outcome, clearStateCookie });
  const cookieState = getCookie(req, oauthStateCookieName(cookieMode(deps))) ?? "";
  const qState = url.searchParams.get("state") ?? "";
  if (!cookieState || !qState || !constantTimeEqual(cookieState, qState)) return done(loginError("oauth_state_invalid"));
  const key = `oauth:${cookieState}`;
  const st = await deps.storage.kv.get<StoredState>(key);
  await deps.storage.kv.delete(key);
  if (!st || st.provider !== providerId) return done(loginError("oauth_state_invalid"));
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !code) return done(loginError("oauth_failed"));

  const p = await getProvider(deps, providerId);
  if (!p) return done(loginError("oauth_failed"));
  const ident = await identify(deps, p, code, st.verifier);
  if (typeof ident === "string") return done(loginError(ident));

  if (st.linkUser) {
    const db = await dbOf(deps);
    const sc = sessionCookie(deps.config, req);
    const cur = sc ? await lookupSession(db, deps.now(), sc) : null;
    if (!cur || cur.user.id !== st.linkUser) return done(loginError("oauth_state_invalid"));
    const back = safeNext(st.next);
    const idn = await db.first<{ user_id: string }>("SELECT user_id FROM identities WHERE provider = ? AND subject = ?", [p.id, ident.subject]);
    if (idn && idn.user_id !== st.linkUser) return done(`${back}${back.includes("?") ? "&" : "?"}error=identity_taken`);
    if (!idn) {
      await db.run("INSERT INTO identities (provider, subject, user_id, email) VALUES (?, ?, ?, ?)", [p.id, ident.subject, st.linkUser, ident.email]);
    }
    return done(back);
  }
  const linked = await link(deps, p.id, ident);
  if (typeof linked !== "object") return done(loginError(linked));
  let outcome: LoginOutcome;
  try {
    outcome = await loginUser(deps, linked.userId, "oauth", client);
  } catch (err) {
    if (err instanceof AppError && err.code === "invalid_credentials") {
      return done(loginError("account_disabled"));
    }
    throw err;
  }
  return done(outcome.mfaRequired ? "/login/mfa" : safeNext(st.next), outcome);
}

interface Identity {
  subject: string;
  email: string;
}

const verifiedFlag = (v: unknown) => v === true || v === "true";

async function identify(deps: AuthDeps, p: ProviderConfig, code: string, verifier: string): Promise<Identity | OAuthErrorCode> {
  try {
    const ep = await endpointsFor(deps, p);
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(deps, p.id),
      client_id: p.clientId,
      client_secret: p.clientSecret,
      code_verifier: verifier,
    });
    const res = await fetchOf(deps)(ep.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
      redirect: "error",
    });
    if (!res.ok) return "oauth_failed";
    const tok = (await res.json()) as { access_token?: string };
    if (!tok.access_token) return "oauth_failed";
    if (p.id === "github") {
      const user = await getJson<{ id?: number }>(deps, ep.userinfo, tok.access_token);
      if (!user.id) return "oauth_failed";
      const emails = await getJson<{ email?: string; primary?: boolean; verified?: boolean }[]>(deps, `${GITHUB_API}/user/emails`, tok.access_token);
      const e = Array.isArray(emails) ? emails.find((x) => x.primary && x.verified && x.email) : undefined;
      if (!e?.email) return "email_unverified";
      return { subject: String(user.id), email: normalizeEmail(e.email) };
    }
    const info = await getJson<{ sub?: string; email?: string; email_verified?: unknown }>(deps, ep.userinfo, tok.access_token);
    if (!info.sub) return "oauth_failed";
    if (!info.email || !verifiedFlag(info.email_verified)) return "email_unverified";
    return { subject: info.sub, email: normalizeEmail(info.email) };
  } catch {
    return "oauth_failed";
  }
}

/**
 * The user already linked to this identity. Never links by email (audit M3: an invite
 * accepted by someone else, or any password account, must not be taken over by whoever
 * controls a matching IdP email); linking happens only from a signed-in session.
 * Never creates a user.
 */
async function link(deps: AuthDeps, provider: ProviderId, ident: Identity): Promise<{ userId: string } | OAuthErrorCode> {
  const db = await dbOf(deps);
  const idn = await db.first<{ user_id: string }>("SELECT user_id FROM identities WHERE provider = ? AND subject = ?", [provider, ident.subject]);
  if (idn) return { userId: idn.user_id };
  const u = await getUserByEmail(db, ident.email);
  return u ? "link_required" : "no_account";
}

/** 409 sso_not_configured guard for callers saving policy + providers together. */
export function requireSso(passwordLoginDisabled: boolean, ssoOk: boolean): void {
  if (passwordLoginDisabled && !ssoOk) throw conflict("sso_not_configured", "configure a login provider first");
}
