import { beforeEach, describe, expect, it } from "vitest";
import { isPrivateHost, resetDiscoveryCache, safeNext, setProvider, type ProviderInput } from "../../src/auth/oauth.ts";
import { addUser, enableTotp, setupAdmin, testApp, type Client } from "./helpers.ts";
import type { TestApp } from "../harness.ts";

const ISSUER = "https://idp.example.com";

interface Idp {
  userinfo: Record<string, unknown>;
  ghUser: Record<string, unknown>;
  ghEmails: unknown[];
  discovery: Record<string, unknown>;
  calls: string[];
  tokenForm?: URLSearchParams;
}

function fakeIdp(): Idp & { fetch: typeof fetch } {
  const idp: Idp = {
    userinfo: { sub: "sub-1", email: "u@example.com", email_verified: true },
    ghUser: { id: 42 },
    ghEmails: [{ email: "u@example.com", primary: true, verified: true }],
    discovery: {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
    },
    calls: [],
  };
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    idp.calls.push(url);
    const ok = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    if (url.endsWith("/.well-known/openid-configuration")) return ok(idp.discovery);
    if (url.endsWith("/token") || url.endsWith("/access_token")) {
      idp.tokenForm = new URLSearchParams(String(init?.body));
      return ok({ access_token: "at" });
    }
    if (url === `${ISSUER}/userinfo`) return ok(idp.userinfo);
    if (url === "https://api.github.com/user") return ok(idp.ghUser);
    if (url === "https://api.github.com/user/emails") return ok(idp.ghEmails);
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return Object.assign(idp, { fetch: f });
}

async function withProvider(app: TestApp, p: Partial<ProviderInput> = {}) {
  await setProvider(app.deps, { id: "oidc", enabled: true, client_id: "cid", client_secret: "csecret", issuer: ISSUER, name: "Corp", ...p });
}

async function flow(app: TestApp, provider = "oidc", next = "/orgs/x"): Promise<Response> {
  const start = await app.call("GET", `/api/auth/oauth/${provider}/start?next=${encodeURIComponent(next)}`);
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.get("location") as string);
  const state = loc.searchParams.get("state") as string;
  const cookie = (start.headers.get("set-cookie") as string).split(";")[0] as string;
  return app.call("GET", `/api/auth/oauth/${provider}/callback?code=c1&state=${state}`, { headers: { cookie } });
}

const loc = (r: Response) => r.headers.get("location");

/** A user with an identity already linked (linking itself needs a session: see "links from a session"). */
async function linkedUser(app: TestApp, email: string, provider = "oidc", subject = "sub-1"): Promise<string> {
  const id = (await app.deps.storage.db.first<{ id: string }>("SELECT id FROM users WHERE email = ?", [email]))?.id ?? (await addUser(app, email));
  await app.deps.storage.db.run("INSERT INTO identities (provider, subject, user_id, email) VALUES (?, ?, ?, ?)", [provider, subject, id, email]);
  return id;
}

/** Runs the link flow for a signed-in client; returns the callback response. */
async function linkFlow(app: TestApp, c: Client, provider = "oidc", next = "/me/security"): Promise<Response> {
  const res = await c.call("POST", `/api/me/oauth/${provider}/link`, { next });
  expect(res.status).toBe(200);
  const start = ((await res.json()) as { location: string }).location;
  const state = new URL(start).searchParams.get("state") as string;
  const cookie = (res.headers.get("set-cookie") as string).split(";")[0] as string;
  return app.call("GET", `/api/auth/oauth/${provider}/callback?code=c1&state=${state}`, { headers: { cookie: `${cookie}; ${c.cookie}` } });
}

describe("oauth", () => {
  let idp: ReturnType<typeof fakeIdp>;
  let app: TestApp;
  beforeEach(() => {
    resetDiscoveryCache();
    idp = fakeIdp();
    app = testApp({ fetch: idp.fetch });
  });

  it("providers list and start builds a PKCE S256 URL; unknown provider 404", async () => {
    expect((await app.call("GET", "/api/auth/oauth/oidc/start")).status).toBe(404);
    await withProvider(app);
    expect(await (await app.call("GET", "/api/auth/providers")).json()).toEqual({ password_login_disabled: false, providers: [{ id: "oidc", name: "Corp" }] });
    const res = await app.call("GET", "/api/auth/oauth/oidc/start");
    const u = new URL(loc(res) as string);
    expect(u.origin + u.pathname).toBe(`${ISSUER}/authorize`);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe("https://console.test/api/auth/oauth/oidc/callback");
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-rtw_oauth=.+; Max-Age=600;/);
    expect((await app.call("GET", "/api/auth/oauth/bogus/start")).status).toBe(404);
  });

  it("signs in a linked user", async () => {
    await withProvider(app);
    await linkedUser(app, "u@example.com");
    const res = await flow(app);
    expect(loc(res)).toBe("/orgs/x");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-rtw_session="))).toBe(true);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-rtw_oauth=;"))).toBe(true);
    expect(idp.tokenForm?.get("code_verifier")).toBeTruthy();
    expect(idp.tokenForm?.get("client_secret")).toBe("csecret");
    // linked identity wins even if the email changes upstream
    idp.userinfo = { sub: "sub-1", email: "other@example.com", email_verified: true };
    expect(loc(await flow(app))).toBe("/orgs/x");
  });

  it("never auto-links by email (M3): link_required, no identity row, no session", async () => {
    await withProvider(app);
    await addUser(app, "u@example.com");
    const res = await flow(app);
    expect(loc(res)).toBe("/login?error=link_required");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-rtw_session="))).toBe(false);
    const n = await app.deps.storage.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM identities");
    expect(Number(n?.n)).toBe(0);
  });

  it("links from a signed-in session, then signs in with the provider", async () => {
    await withProvider(app);
    const admin = await setupAdmin(app);
    idp.userinfo = { sub: "sub-9", email: "someone-else@example.com", email_verified: true };
    const res = await linkFlow(app, admin);
    expect(loc(res)).toBe("/me/security");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-rtw_session="))).toBe(false);
    const row = await app.deps.storage.db.first<{ user_id: string }>("SELECT user_id FROM identities WHERE provider='oidc' AND subject='sub-9'");
    expect(row?.user_id).toMatch(/^usr/);
    expect(loc(await flow(app))).toBe("/orgs/x");
  });

  it("link needs a session and CSRF, and refuses an identity linked to someone else", async () => {
    await withProvider(app);
    expect((await app.call("POST", "/api/me/oauth/oidc/link", { body: {}, headers: { origin: "https://console.test" } })).status).toBe(401);
    const admin = await setupAdmin(app);
    expect((await admin.call("POST", "/api/me/oauth/oidc/link", {}, { "x-csrf-token": "bad" })).status).toBe(403);
    expect((await admin.call("POST", "/api/me/oauth/bogus/link", {})).status).toBe(404);
    await linkedUser(app, "u@example.com", "oidc", "sub-1");
    expect(loc(await linkFlow(app, admin))).toBe("/me/security?error=identity_taken");
  });

  it("never creates a user: no_account", async () => {
    await withProvider(app);
    expect(loc(await flow(app))).toBe("/login?error=no_account");
    const n = await app.deps.storage.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM users");
    expect(Number(n?.n)).toBe(0);
  });

  it.each([[false], ["false"], [undefined]])("unverified email (%s) is email_unverified", async (v) => {
    await withProvider(app);
    await addUser(app, "u@example.com");
    idp.userinfo = { sub: "s", email: "u@example.com", email_verified: v };
    expect(loc(await flow(app))).toBe("/login?error=email_unverified");
  });

  it("disabled users are account_disabled", async () => {
    await withProvider(app);
    await linkedUser(app, "u@example.com");
    expect(loc(await flow(app))).toBe("/orgs/x");
    await app.deps.storage.db.run("UPDATE users SET disabled = 1");
    expect(loc(await flow(app))).toBe("/login?error=account_disabled");
  });

  it("state: forged, missing cookie, reused are oauth_state_invalid", async () => {
    await withProvider(app);
    await linkedUser(app, "u@example.com");
    const start = await app.call("GET", "/api/auth/oauth/oidc/start");
    const state = new URL(loc(start) as string).searchParams.get("state") as string;
    const cookie = (start.headers.get("set-cookie") as string).split(";")[0] as string;
    expect(loc(await app.call("GET", `/api/auth/oauth/oidc/callback?code=c&state=forged`, { headers: { cookie } }))).toBe("/login?error=oauth_state_invalid");
    expect(loc(await app.call("GET", `/api/auth/oauth/oidc/callback?code=c&state=${state}`))).toBe("/login?error=oauth_state_invalid");
    // first attempt above with a forged state consumed nothing; a valid one works once
    expect(loc(await app.call("GET", `/api/auth/oauth/oidc/callback?code=c&state=${state}`, { headers: { cookie } }))).toBe("/");
    expect(loc(await app.call("GET", `/api/auth/oauth/oidc/callback?code=c&state=${state}`, { headers: { cookie } }))).toBe("/login?error=oauth_state_invalid");
  });

  it("OAuth login still requires TOTP", async () => {
    await withProvider(app, {});
    const admin: Client = await setupAdmin(app);
    await enableTotp(app, admin);
    await linkedUser(app, "admin@example.com", "oidc", "s");
    idp.userinfo = { sub: "s", email: "admin@example.com", email_verified: true };
    expect(loc(await flow(app))).toBe("/login/mfa");
  });

  it("github uses the primary verified email", async () => {
    await setProvider(app.deps, { id: "github", enabled: true, client_id: "gh", client_secret: "ghs" });
    await linkedUser(app, "u@example.com", "github", "42");
    idp.ghEmails = [{ email: "u@example.com", primary: true, verified: false }];
    expect(loc(await flow(app, "github"))).toBe("/login?error=email_unverified");
    idp.ghEmails = [{ email: "x@example.com", primary: false, verified: true }, { email: "u@example.com", primary: true, verified: true }];
    expect(loc(await flow(app, "github"))).toBe("/orgs/x");
  });

  it("discovery: issuer mismatch, http endpoints and http issuer fail; cached 10 min", async () => {
    await withProvider(app);
    idp.discovery = { ...idp.discovery, issuer: "https://evil.example.com" };
    expect((await app.call("GET", "/api/auth/oauth/oidc/start")).status).toBe(500);
    idp.discovery = { ...idp.discovery, issuer: ISSUER, token_endpoint: "http://idp.example.com/token" };
    expect((await app.call("GET", "/api/auth/oauth/oidc/start")).status).toBe(500);
    await expect(setProvider(app.deps, { id: "oidc", enabled: true, client_id: "c", issuer: "http://idp.example.com" })).rejects.toMatchObject({ status: 422 });
    idp.discovery = { ...idp.discovery, token_endpoint: `${ISSUER}/token` };
    idp.calls = [];
    await app.call("GET", "/api/auth/oauth/oidc/start");
    await app.call("GET", "/api/auth/oauth/oidc/start");
    expect(idp.calls.filter((c) => c.includes("well-known"))).toHaveLength(1);
    app.tick(10 * 60_000);
    await app.call("GET", "/api/auth/oauth/oidc/start");
    expect(idp.calls.filter((c) => c.includes("well-known"))).toHaveLength(2);
  });

  it("rejects private issuers", async () => {
    await withProvider(app, { issuer: "https://10.0.0.5" });
    expect((await app.call("GET", "/api/auth/oauth/oidc/start")).status).toBe(500);
    expect(idp.calls).toHaveLength(0);
    for (const h of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "[::1]", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "localhost", "100.64.0.1"]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ["8.8.8.8", "idp.example.com", "2606:4700::1"]) expect(isPrivateHost(h), h).toBe(false);
  });

  it("client secret is sealed at rest", async () => {
    await withProvider(app);
    const rows = await app.deps.storage.db.all<{ value: string }>("SELECT value FROM settings");
    expect(rows.some((r) => r.value.includes("csecret"))).toBe(false);
  });

  it("safeNext keeps same-origin paths only", () => {
    expect(safeNext("/a?b")).toBe("/a?b");
    expect(safeNext("/orgs/x/apps?tab=logs#top")).toBe("/orgs/x/apps?tab=logs#top");
    const bad = ["//evil", "https://evil", "/\\evil", "", null, "/\t/evil.com", "/\n/evil.com", "/\r/evil.com", "/\\\\evil.com",
      "//evil.com", "/%2F%2Fevil.com", "/%2f/evil.com", "/%5Cevil.com", "/%09/evil.com", "/ /evil.com", "/a b", "/\u00e9", "/%E0%A4%A", "evil.com"];
    for (const b of bad) expect(safeNext(b), JSON.stringify(b)).toBe("/");
  });
});
