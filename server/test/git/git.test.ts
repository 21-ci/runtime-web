import { afterEach, describe, expect, it, vi } from "vitest";
import { errOf, APPS } from "../apps/helpers.ts";
import { TEST_ORIGIN } from "../harness.ts";
import { delivery, GIT, gitWorld, SHA_NEW, SHA_OLD, TOKEN } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

describe("link CRUD", () => {
  it("creates a link, shows the secret once and never returns the token", async () => {
    const w = await gitWorld();
    const res = await w.owner.call("POST", GIT, { provider: "github", base_url: "https://github.com", repo: "acme/hello", branch: "main", token: TOKEN });
    expect(res.status).toBe(201);
    const created = await res.text();
    expect(created).not.toContain(TOKEN);
    const b = JSON.parse(created) as { hook_secret: string; hook_id: string; webhook_url: string; has_token: boolean };
    expect(b.hook_secret.length).toBeGreaterThan(20);
    expect(b.webhook_url).toBe(`${TEST_ORIGIN}/api/hooks/git/${b.hook_id}`);
    expect(b.has_token).toBe(true);

    const read = await (await w.owner.call("GET", GIT)).text();
    expect(read).not.toContain(TOKEN);
    expect(read).not.toContain(b.hook_secret);
    expect(JSON.parse(read).link.has_token).toBe(true);
  });

  it("seals the token and secret at rest, bound to their row", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    const row = await w.app.deps.storage.db.first<{ t: Uint8Array; s: Uint8Array }>("SELECT token_sealed AS t, hook_secret_sealed AS s FROM git_links WHERE hook_id = ?", [hook]);
    const text = (b: Uint8Array | undefined) => new TextDecoder("latin1").decode(new Uint8Array(b ?? []));
    expect(text(row?.t)).not.toContain(TOKEN);
    expect(text(row?.s)).not.toContain(secret);
    expect(row?.t.length).toBeGreaterThan(TOKEN.length);
  });

  it("is project admin only: developers and viewers get 403, tokens 403", async () => {
    const w = await gitWorld();
    await w.link();
    const dev = await w.user("dev@example.com", "member", { default: "developer" });
    const viewer = await w.user("view@example.com", "member", { default: "viewer" });
    const padmin = await w.user("padmin@example.com", "member", { default: "admin" });
    for (const c of [dev, viewer]) {
      expect((await c.call("GET", GIT)).status).toBe(403);
      expect((await c.call("PATCH", GIT, { branch: "x" })).status).toBe(403);
      expect((await c.call("DELETE", GIT)).status).toBe(403);
      expect((await c.call("PUT", `${GIT}/rules`, { rules: [] })).status).toBe(403);
      expect((await c.call("POST", GIT, {})).status).toBe(403);
    }
    expect((await padmin.call("GET", GIT)).status).toBe(200);
  });

  it("does not let another org reach a link (IDOR)", async () => {
    const w = await gitWorld();
    await w.link();
    await w.addOrg("rival");
    const outsider = await w.user("out@example.com", null);
    expect((await outsider.call("GET", GIT)).status).toBe(404);
    expect((await outsider.call("DELETE", GIT)).status).toBe(404);
    // A member of the rival org, naming the rival org and the victim's app slug.
    const uid = (await w.app.deps.storage.db.first<{ id: string }>("SELECT id FROM users WHERE email = ?", ["out@example.com"]))?.id;
    await w.app.deps.storage.db.run("INSERT INTO members (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', 0)", ["org_rival", uid ?? ""]);
    const path = "/api/orgs/rival/apps/hello/git";
    expect((await outsider.call("GET", path)).status).toBe(404);
    expect((await outsider.call("PATCH", path, { branch: "x" })).status).toBe(404);
    expect((await outsider.call("DELETE", path)).status).toBe(404);
    expect((await w.owner.call("GET", GIT)).status).toBe(200);
    expect(((await (await w.owner.call("GET", GIT)).json()) as { link: unknown }).link).not.toBeNull();
  });

  it("refuses a second link on one app", async () => {
    const w = await gitWorld();
    await w.link();
    const res = await w.owner.call("POST", GIT, { provider: "github", base_url: "https://github.com", repo: "acme/x", branch: "main" });
    expect(res.status).toBe(409);
    expect((await errOf(res)).code).toBe("git_link_exists");
  });

  it.each(["base_url", "provider", "repo"])("refuses editing %s: delete and recreate", async (field) => {
    const w = await gitWorld();
    await w.link();
    const res = await w.owner.call("PATCH", GIT, { [field]: "https://evil.example.com" });
    expect(res.status).toBe(422);
    expect((await errOf(res)).details).toEqual({ fields: { [field]: "immutable" } });
    const link = ((await (await w.owner.call("GET", GIT)).json()) as { link: { base_url: string; repo: string } }).link;
    expect(link.base_url).toBe("https://github.com");
  });

  it("edits branch and token, clears on delete, records audit without secrets", async () => {
    const w = await gitWorld();
    const { hook } = await w.link();
    const res = await w.owner.call("PATCH", GIT, { branch: "release/v1", token: "dev-insecure-other-token" });
    expect(res.status).toBe(200);
    expect((await w.owner.call("DELETE", GIT)).status).toBe(204);
    expect(await w.app.deps.storage.db.first("SELECT 1 AS x FROM git_links WHERE hook_id = ?", [hook])).toBeNull();
    const rows = await w.app.deps.storage.db.all<{ action: string; data: string | null }>("SELECT action, data FROM audit WHERE action LIKE 'git.%'");
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["git.link.create", "git.link.update", "git.link.delete"]));
    expect(JSON.stringify(rows)).not.toContain("token-");
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it("removes the link with its app", async () => {
    const w = await gitWorld();
    await w.link();
    expect((await w.owner.call("DELETE", `${APPS}/hello`)).status).toBe(204);
    expect(await w.app.deps.storage.db.first("SELECT 1 AS x FROM git_links")).toBeNull();
  });
});

describe("base_url SSRF", () => {
  const bad = [
    "http://github.com",
    "https://127.0.0.1",
    "https://localhost",
    "https://localhost.",
    "https://foo.internal",
    "https://10.0.0.8",
    "https://169.254.169.254",
    "https://[::1]",
    "https://[::ffff:127.0.0.1]",
    "https://2130706433",
    "https://0x7f.0.0.1",
    "https://user:pw@github.com",
    "https://github.com/evil/path",
    "https://github.com/?x=1",
    "https://github.com/#f",
    "ftp://github.com",
    "not a url",
    "https://rebind.example.com",
  ];
  it.each(bad)("refuses %s", async (base_url) => {
    const w = await gitWorld();
    w.host.dns["rebind.example.com"] = ["93.184.216.34", "10.0.0.1"];
    const res = await w.owner.call("POST", GIT, { provider: "gitea", base_url, repo: "acme/hello", branch: "main", token: TOKEN });
    expect(res.status).toBe(422);
    expect((await errOf(res)).details).toEqual({ fields: { base_url: expect.any(String) } });
    expect(w.host.calls).toEqual([]);
  });

  it.each([["../../admin/hello"], ["acme/../x"], ["acme"], ["acme/hello/extra"], ["acme/hel lo"]])("refuses repo %s", async (repo) => {
    const w = await gitWorld();
    const res = await w.owner.call("POST", GIT, { provider: "github", base_url: "https://github.com", repo, branch: "main" });
    expect(res.status).toBe(422);
  });

  it("never follows a provider redirect, so the token cannot leave the host", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    await w.push(hook, secret, SHA_NEW);
    await w.tick();
    expect(w.host.calls.length).toBeGreaterThan(0);
    for (const c of w.host.calls) {
      expect(c.redirect).toBe("error");
      expect(new URL(c.url).hostname).toBe("api.github.com");
    }
  });
});

describe("webhook", () => {
  it("is exempt from Origin and CSRF, and needs no session", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    const res = await w.push(hook, secret, SHA_NEW);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "queued" });
  });

  it("answers the same 404 for a tampered signature, a tampered body and an unknown hook", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    const send = (h: string, body: string, sig: string) => w.app.fetch(new Request(`http://localhost/api/hooks/git/${h}`, {
      method: "POST", body, headers: { "x-github-event": "push", "x-hub-signature-256": sig },
    }));
    const good = JSON.stringify({ ref: "refs/heads/main", after: SHA_NEW, repository: { full_name: "acme/hello" } });
    const wrong = await send(hook, good, `sha256=${"0".repeat(64)}`);
    const unknown = await send("ghk_0123456789abcdef0123", good, `sha256=${"0".repeat(64)}`);
    const signed = await w.push(hook, "dev-insecure-wrong-secret", SHA_NEW);
    const none = await w.app.fetch(new Request(`http://localhost/api/hooks/git/${hook}`, { method: "POST", body: good }));
    const texts = await Promise.all([wrong, unknown, signed, none].map(async (r) => [r.status, await r.text()]));
    for (const t of texts) expect(t).toEqual(texts[1]);
    expect(wrong.status).toBe(404);
    expect(await w.app.deps.storage.db.first("SELECT 1 AS x FROM git_deliveries")).toBeNull();
    void secret;
  });

  it("rate limits per hook before checking the signature", async () => {
    const w = await gitWorld();
    const { hook } = await w.link();
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await w.push(hook, "dev-insecure-wrong-secret", SHA_NEW)).status;
    expect(last).toBe(429);
  });

  it("caps the body at 1 MiB", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    const res = await w.push(hook, secret, SHA_NEW, { body: "x".repeat((1 << 20) + 1) });
    expect(res.status).toBe(413);
  });

  it("ignores another branch, a tag named like the branch, deletes and other events", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    for (const ref of ["refs/heads/other", "refs/tags/main", "refs/pull/1/head"]) {
      const res = await w.push(hook, secret, SHA_NEW, { ref });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "ignored" });
    }
    expect((await (await w.push(hook, secret, "0".repeat(40))).json())).toEqual({ status: "ignored" });
    expect(await w.app.deps.storage.db.first("SELECT 1 AS x FROM git_deliveries")).toBeNull();
  });

  it("never deploys a push from another repository, such as a fork", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    const res = await w.push(hook, secret, SHA_NEW, { repo: "mallory/hello", fork: true });
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(w.fake.fromUrlCalls).toEqual([]);
  });

  it("runs the first step inline when the runtime lets the task outlive the response", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    const waits: Promise<unknown>[] = [];
    const body = JSON.stringify({ ref: "refs/heads/main", after: SHA_NEW, repository: { full_name: "acme/hello" } });
    const { hex, hmacSha256 } = await import("../../src/crypto/hash.ts");
    const sig = hex(await hmacSha256(secret, new TextEncoder().encode(body)));
    const res = await w.app.fetch(new Request(`http://localhost/api/hooks/git/${hook}`, {
      method: "POST", body, headers: { "x-github-event": "push", "x-hub-signature-256": `sha256=${sig}` },
    }), { waitUntil: (p) => void waits.push(p) });
    expect(res.status).toBe(202);
    await Promise.all(waits);
    expect(w.fake.fromUrlCalls).toHaveLength(1);
  });
});

describe("deploy job", () => {
  it("deploys the head to the app with after_build and posts a commit status with the URL", async () => {
    const w = await gitWorld({ config: { origin: TEST_ORIGIN, sealKey: new Uint8Array(32).fill(7), insecureCookies: false, setupToken: "test-setup-token-0123456789abcdef", runtimePublicUrl: "https://apps.test", defaultPlan: "free" } });
    const { hook, secret } = await w.link();
    await w.push(hook, secret, SHA_NEW);
    await w.tick();
    expect(w.fake.fromUrlCalls).toHaveLength(1);
    const call = w.fake.fromUrlCalls[0];
    expect(call?.service).toBe(w.serviceId);
    expect(call?.body).toMatchObject({
      url: `https://api.github.com/repos/acme/hello/tarball/${SHA_NEW}`,
      headers: { authorization: `Bearer ${TOKEN}` },
      strip_components: 1,
      compile: "eager",
      activate: "after_build",
      meta: { git: { sha: SHA_NEW, ref: "refs/heads/main", repo: "acme/hello", author: "Dev", message: "fix: a thing" } },
    });
    expect(call?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    await w.tick();
    expect((await delivery(w, SHA_NEW))?.state).toBe("deployed");
    const st = w.host.statuses();
    expect(st.map((s) => (s.body as { state: string }).state)).toEqual(["pending", "success"]);
    expect(st[1]?.url).toBe(`https://api.github.com/repos/acme/hello/statuses/${SHA_NEW}`);
    expect((st[1]?.body as { target_url: string }).target_url).toBe("https://hello.apps.test/");
  });

  it("a replayed old push with a new delivery id cannot roll back", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    await w.push(hook, secret, SHA_NEW);
    await w.tick();
    w.host.head = SHA_NEW;
    // A captured, correctly signed push of an older commit, never seen here, under a fresh delivery id.
    expect((await w.push(hook, secret, SHA_OLD, { delivery: "fresh-id" })).status).toBe(202);
    await w.tick();
    expect(w.fake.fromUrlCalls).toHaveLength(1);
    expect((w.fake.fromUrlCalls[0]?.body as { url: string }).url).toContain(SHA_NEW);
    expect(await delivery(w, SHA_OLD)).toMatchObject({ state: "skipped", error: "already_deployed" });
  });

  it("deploys the current head, not the hinted commit, when the two differ", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    w.host.head = SHA_NEW;
    await w.push(hook, secret, SHA_OLD);
    await w.tick();
    expect((w.fake.fromUrlCalls[0]?.body as { url: string }).url).toContain(SHA_NEW);
    expect(JSON.stringify(w.fake.fromUrlCalls)).not.toContain(SHA_OLD);
  });

  it("a duplicate delivery deploys once, a force push back to an older commit deploys it", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    w.host.head = SHA_OLD;
    await w.push(hook, secret, SHA_OLD);
    await w.tick();
    await w.tick();
    expect((await w.push(hook, secret, SHA_OLD)).status).toBe(202);
    await w.tick();
    expect(w.fake.fromUrlCalls).toHaveLength(1);
    w.host.head = SHA_NEW;
    await w.push(hook, secret, SHA_NEW);
    await w.tick();
    await w.tick();
    expect(w.fake.fromUrlCalls).toHaveLength(2);
    w.host.head = SHA_OLD;
    await w.push(hook, secret, SHA_OLD);
    await w.tick();
    expect(w.fake.fromUrlCalls).toHaveLength(3);
    expect((w.fake.fromUrlCalls[2]?.body as { url: string }).url).toContain(SHA_OLD);
    // A later attempt of a new delivery must not replay the first build under an idempotency key.
    expect(w.fake.fromUrlCalls[2]?.idempotencyKey).not.toBe(w.fake.fromUrlCalls[0]?.idempotencyKey);
  });

  it("fails closed when a linked token cannot read the head", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    w.host.headStatus = 401;
    await w.push(hook, secret, SHA_NEW);
    await w.tick();
    expect(w.fake.fromUrlCalls).toEqual([]);
    expect(await delivery(w, SHA_NEW)).toMatchObject({ state: "failed", error: "head_check_failed" });
  });

  it("retries a provider outage, never deploying on an unknown head", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    w.host.headStatus = 503;
    await w.push(hook, secret, SHA_NEW);
    await w.tick();
    expect(w.fake.fromUrlCalls).toEqual([]);
    expect((await delivery(w, SHA_NEW))?.state).toBe("queued");
    w.host.headStatus = 200;
    w.app.tick(600_000);
    await w.tick();
    expect(w.fake.fromUrlCalls).toHaveLength(1);
  });

  it("without a token: reads a public head, and refuses a commit already deployed when it cannot", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link({ token: undefined });
    w.host.head = SHA_OLD;
    await w.push(hook, secret, SHA_OLD);
    await w.tick();
    expect(w.fake.fromUrlCalls).toHaveLength(1);
    expect(w.fake.fromUrlCalls[0]?.body).not.toHaveProperty("headers");
    await w.tick();
    w.host.head = SHA_NEW;
    await w.push(hook, secret, SHA_NEW);
    await w.tick();
    await w.tick();
    expect(w.fake.fromUrlCalls).toHaveLength(2);
    expect(w.host.statuses()).toEqual([]);
    // The head turns unreadable, and the old push is replayed.
    w.host.headStatus = 404;
    await w.push(hook, secret, SHA_OLD, { delivery: "replay" });
    await w.tick();
    expect(w.fake.fromUrlCalls).toHaveLength(2);
    expect(await delivery(w, SHA_OLD)).toMatchObject({ state: "skipped", error: "already_deployed" });
  });

  it("marks a failed build failed, leaves live alone and posts failure", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    const before = w.fake.services.get(w.serviceId)?.live;
    w.fake.nextBuildState = "failed";
    await w.push(hook, secret, SHA_NEW);
    await w.tick();
    await w.tick();
    expect(await delivery(w, SHA_NEW)).toMatchObject({ state: "failed", error: "build_failed" });
    expect(w.fake.services.get(w.serviceId)?.live).toBe(before);
    expect(w.host.statuses().map((s) => (s.body as { state: string }).state)).toEqual(["pending", "failure"]);
    // The same commit can be retried: it never went live.
    w.fake.nextBuildState = "ready";
    await w.push(hook, secret, SHA_NEW);
    await w.tick();
    expect(w.fake.fromUrlCalls).toHaveLength(2);
  });

  it("stores only a stable code for a runtime refusal", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    w.fake.fromUrlFailure = "egress_denied";
    await w.push(hook, secret, SHA_NEW);
    await w.tick();
    await w.tick();
    expect(await delivery(w, SHA_NEW)).toMatchObject({ state: "failed", error: "egress_denied" });
    const dump = JSON.stringify(await w.app.deps.storage.db.all("SELECT * FROM git_deliveries"));
    expect(dump).not.toContain(TOKEN);
  });

  it("does not activate when auto_promote is off", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link({ auto_promote: false });
    await w.push(hook, secret, SHA_NEW);
    await w.tick();
    expect(w.fake.fromUrlCalls[0]?.body).toMatchObject({ activate: null });
  });

  it("never writes the token to logs, responses, audit or delivery rows across the whole flow", async () => {
    const seen: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void seen.push(a.map(String).join(" ")));
    }
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    w.fake.fromUrlError = { status: 502, code: "fetch_failed", message: "x" };
    await w.push(hook, secret, SHA_NEW);
    await w.tick();
    w.fake.fromUrlError = null;
    w.app.tick(600_000);
    await w.tick();
    await w.tick();
    const view = await (await w.owner.call("GET", GIT)).text();
    const audit = JSON.stringify(await w.app.deps.storage.db.all("SELECT * FROM audit"));
    const rows = JSON.stringify(await w.app.deps.storage.db.all("SELECT * FROM git_deliveries"));
    for (const hay of [seen.join("\n"), view, audit, rows]) {
      expect(hay).not.toContain(TOKEN);
      expect(hay).not.toContain(secret);
    }
  });

  it("prunes deliveries after 30 days, but keeps what a tokenless link needs to refuse a replay", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    await w.push(hook, secret, SHA_NEW);
    await w.tick();
    await w.tick();
    w.app.tick(31 * 86_400_000);
    await w.tick();
    expect(await delivery(w, SHA_NEW)).toBeNull();

    const bare = await gitWorld();
    const l = await bare.link({ token: undefined });
    await bare.push(l.hook, l.secret, SHA_NEW);
    await bare.tick();
    await bare.tick();
    bare.app.tick(31 * 86_400_000);
    await bare.tick();
    expect((await delivery(bare, SHA_NEW))?.state).toBe("deployed");
  });
});

describe("branch rules", () => {
  const rules = (w: Awaited<ReturnType<typeof gitWorld>>, list: unknown[]) => w.owner.call("PUT", `${GIT}/rules`, { rules: list });

  it("deploys a matching push to its branch, creating the branch, with no auto switch by default", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    expect((await rules(w, [{ ref_pattern: "feature/*", branch_name: "staging" }])).status).toBe(200);
    expect((await w.push(hook, secret, SHA_NEW, { ref: "refs/heads/feature/x" })).status).toBe(202);
    await w.tick();
    const b = w.fake.branchOf(w.serviceId, "staging");
    expect(b).toBeDefined();
    expect(w.fake.fromUrlCalls[0]?.service).toBe(b?.view.id);
    expect(w.fake.fromUrlCalls[0]?.body).toMatchObject({ activate: "after_build" });
    await w.tick();
    expect(w.fake.switches.get(w.serviceId) ?? []).toEqual([]);
    expect(w.host.calls.some((c) => c.url.endsWith("/branches/feature%2Fx"))).toBe(true);
  });

  it("does not let a glob cross a path separator or match the whole ref wrongly", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    await rules(w, [{ ref_pattern: "feature/*", branch_name: "staging" }]);
    expect(await (await w.push(hook, secret, SHA_NEW, { ref: "refs/heads/feature/a/b" })).json()).toEqual({ status: "ignored" });
    expect(await (await w.push(hook, secret, SHA_NEW, { ref: "refs/tags/feature/a" })).json()).toEqual({ status: "ignored" });
  });

  it("auto_switch switches after the build, re-reading the head first", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    await rules(w, [{ ref_pattern: "feature/*", branch_name: "staging", auto_switch: true }]);
    await w.push(hook, secret, SHA_NEW, { ref: "refs/heads/feature/x" });
    await w.tick();
    await w.tick();
    expect(w.fake.switches.get(w.serviceId)?.length).toBe(1);
    const audit = await w.app.deps.storage.db.first<{ action: string; actor_id: string | null }>("SELECT action, actor_id FROM audit WHERE action = 'app.switch'");
    expect(audit).toMatchObject({ action: "app.switch", actor_id: null });
  });

  it("does not auto switch a build the branch has moved past", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    await rules(w, [{ ref_pattern: "feature/*", branch_name: "staging", auto_switch: true }]);
    await w.push(hook, secret, SHA_NEW, { ref: "refs/heads/feature/x" });
    await w.tick();
    w.host.head = SHA_OLD;
    await w.tick();
    expect(w.fake.switches.get(w.serviceId) ?? []).toEqual([]);
  });

  it.each([
    ["the hook says the repo is a fork", { payloadFork: true, apiFork: false }],
    ["only the provider says the repo is a fork", { payloadFork: false, apiFork: true }],
  ])("forks never auto switch: %s", async (_n, o) => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    await rules(w, [{ ref_pattern: "feature/*", branch_name: "staging", auto_switch: true }]);
    w.host.fork = o.apiFork;
    await w.push(hook, secret, SHA_NEW, { ref: "refs/heads/feature/x", fork: o.payloadFork });
    await w.tick();
    await w.tick();
    expect(w.fake.fromUrlCalls).toHaveLength(1);
    expect(w.fake.switches.get(w.serviceId) ?? []).toEqual([]);
  });

  it("a paused rule still builds but never switches", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    await rules(w, [{ ref_pattern: "feature/*", branch_name: "staging", auto_switch: true, paused: true }]);
    await w.push(hook, secret, SHA_NEW, { ref: "refs/heads/feature/x" });
    await w.tick();
    await w.tick();
    expect(w.fake.fromUrlCalls).toHaveLength(1);
    expect(w.fake.switches.get(w.serviceId) ?? []).toEqual([]);
  });

  it("a manual rollback pauses the link and its rules, so the next push cannot undo it", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    await rules(w, [{ ref_pattern: "feature/*", branch_name: "staging", auto_switch: true }]);
    await w.push(hook, secret, SHA_NEW, { ref: "refs/heads/feature/x" });
    await w.tick();
    await w.tick();
    const row = w.fake.switches.get(w.serviceId)?.[0];
    const etag = (await w.owner.call("GET", `${APPS}/hello`)).headers.get("etag") ?? "";
    expect((await w.owner.call("POST", `${APPS}/hello/switches/${row?.id}/rollback`, undefined, { "if-match": etag })).status).toBe(202);
    const view = (await (await w.owner.call("GET", GIT)).json()) as { link: { paused: boolean }; rules: { paused: boolean }[] };
    expect(view.link.paused).toBe(true);
    expect(view.rules[0]?.paused).toBe(true);
    w.host.head = SHA_OLD;
    await w.push(hook, secret, SHA_OLD);
    await w.tick();
    expect(w.fake.fromUrlCalls.at(-1)?.body).toMatchObject({ activate: null });
    // An admin resumes.
    expect((await w.owner.call("PATCH", GIT, { paused: false })).status).toBe(200);
  });

  it("promoting a version older than a git deploy pauses too; promoting forward does not", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    await w.push(hook, secret, SHA_NEW);
    await w.tick();
    await w.tick();
    const etag = async () => (await w.owner.call("GET", `${APPS}/hello`)).headers.get("etag") ?? "";
    const paused = async () => ((await (await w.owner.call("GET", GIT)).json()) as { link: { paused: boolean } }).link.paused;
    expect((await w.owner.call("PUT", `${APPS}/hello/live`, { version: 2 }, { "if-match": await etag() })).status).toBe(200);
    expect(await paused()).toBe(false);
    expect((await w.owner.call("PUT", `${APPS}/hello/live`, { version: 1 }, { "if-match": await etag() })).status).toBe(200);
    expect(await paused()).toBe(true);
  });

  it.each([
    [{ ref_pattern: "", branch_name: "x" }],
    [{ ref_pattern: "a/**/../b", branch_name: "x" }],
    [{ ref_pattern: "*", branch_name: "Bad_Name" }],
    [{ ref_pattern: "*", branch_name: "x", extra: 1 }],
    [{ ref_pattern: "*", branch_name: "x", auto_switch: "yes" }],
  ])("refuses rule %j", async (rule) => {
    const w = await gitWorld();
    await w.link();
    expect((await rules(w, [rule])).status).toBe(422);
  });
});

describe("POST …/deploys", () => {
  const DEPLOYS = `${APPS}/hello/deploys`;

  it("deploys a URL for a developer, without any stored token, and hides the URL from audit", async () => {
    const w = await gitWorld();
    await w.link();
    const dev = await w.user("dev@example.com", "member", { default: "developer" });
    const url = "https://objects.example.com/build.tgz?sig=dev-insecure-signature";
    const res = await dev.call("POST", DEPLOYS, { url, sha: SHA_NEW, ref: "refs/heads/main" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ version: 2, build_state: "fetching" });
    expect(w.fake.fromUrlCalls[0]?.body).toMatchObject({ url, activate: "after_build", meta: { git: { sha: SHA_NEW } } });
    expect(w.fake.fromUrlCalls[0]?.body).not.toHaveProperty("headers");
    const audit = JSON.stringify(await w.app.deps.storage.db.all("SELECT data FROM audit WHERE action = 'app.deploy'"));
    expect(audit).not.toContain("sig=");
    expect(audit).toContain("objects.example.com");
  });

  it("forbids a viewer and hides the app from another org", async () => {
    const w = await gitWorld();
    const viewer = await w.user("v@example.com", "member", { default: "viewer" });
    expect((await viewer.call("POST", DEPLOYS, { url: "https://x.example.com/a.tgz" })).status).toBe(403);
    const out = await w.user("o@example.com", null);
    expect((await out.call("POST", DEPLOYS, { url: "https://x.example.com/a.tgz" })).status).toBe(404);
  });

  it.each(["http://x.example.com/a.tgz", "https://127.0.0.1/a.tgz", "https://u:p@x.example.com/a.tgz", "https://169.254.169.254/latest", "https://localhost/a"])("refuses url %s", async (url) => {
    const w = await gitWorld();
    const res = await w.owner.call("POST", DEPLOYS, { url });
    expect(res.status).toBe(422);
    expect(w.fake.fromUrlCalls).toEqual([]);
  });

  it("answers fetching, and a fetch that fails shows on the version", async () => {
    const w = await gitWorld();
    w.fake.fromUrlFailure = "fetch_failed";
    w.fake.fromUrlHold = true;
    const res = await w.owner.call("POST", DEPLOYS, { url: "https://x.example.com/a.tgz" });
    expect(res.status).toBe(202);
    const out = (await res.json()) as { version: number; build_state: string };
    expect(out.build_state).toBe("fetching");
    w.fake.releaseFetches();
    const list = (await (await w.owner.call("GET", `${APPS}/hello/versions`)).json()) as { items: { version: number; build_state: string; failure: { code: string } | null }[] };
    expect(list.items.find((v) => v.version === out.version)).toMatchObject({ build_state: "failed", failure: { code: "fetch_failed" } });
  });

  it("passes on a build quota refusal", async () => {
    const w = await gitWorld();
    w.fake.fromUrlError = { status: 429, code: "build_quota", message: "x" };
    const res = await w.owner.call("POST", DEPLOYS, { url: "https://x.example.com/a.tgz" });
    expect(res.status).toBe(429);
    expect((await errOf(res)).code).toBe("build_quota");
  });
});

describe("providers", () => {
  it("speaks GitLab's archive URL, token header and status states", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link({ provider: "gitlab", base_url: "https://gitlab.example.com", repo: "group/sub/hello" });
    const body = JSON.stringify({ ref: "refs/heads/main", after: SHA_NEW, project: { path_with_namespace: "group/sub/hello" } });
    const res = await w.app.fetch(new Request(`http://localhost/api/hooks/git/${hook}`, { method: "POST", body, headers: { "x-gitlab-event": "Push Hook", "x-gitlab-token": secret } }));
    expect(await res.json()).toEqual({ status: "queued" });
    w.fake.nextBuildState = "failed";
    await w.tick();
    await w.tick();
    expect(w.fake.fromUrlCalls[0]?.body).toMatchObject({
      url: `https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fhello/repository/archive.tar.gz?sha=${SHA_NEW}`,
      headers: { "private-token": TOKEN },
    });
    expect(w.host.statuses().map((s) => (s.body as { state: string }).state)).toEqual(["pending", "failed"]);
  });

  it("speaks Gitea's", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link({ provider: "gitea", base_url: "https://gitea.example.com" });
    const body = JSON.stringify({ ref: "refs/heads/main", after: SHA_NEW, repository: { full_name: "acme/hello" } });
    const { hex, hmacSha256 } = await import("../../src/crypto/hash.ts");
    const sig = hex(await hmacSha256(secret, new TextEncoder().encode(body)));
    const res = await w.app.fetch(new Request(`http://localhost/api/hooks/git/${hook}`, { method: "POST", body, headers: { "x-gitea-event": "push", "x-gitea-signature": sig } }));
    expect(await res.json()).toEqual({ status: "queued" });
    await w.tick();
    expect(w.fake.fromUrlCalls[0]?.body).toMatchObject({
      url: `https://gitea.example.com/api/v1/repos/acme/hello/archive/${SHA_NEW}.tar.gz`,
      headers: { authorization: `token ${TOKEN}` },
    });
  });
});
