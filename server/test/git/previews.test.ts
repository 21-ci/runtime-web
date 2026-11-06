// Pull request webhooks to previews: fork approval bound to a SHA, numeric repo ids, per-PR keys and cross-org 404s.
import { describe, expect, it } from "vitest";
import { hex, hmacSha256 } from "../../src/crypto/hash.ts";
import { HOUSEKEEPING_JOBS } from "../../src/jobs.ts";
import { runJobs } from "../../src/jobs/runner.ts";
import { APPS, errOf } from "../apps/helpers.ts";
import { gitWorld, GIT, SHA_NEW, SHA_OLD, type GitWorld } from "./helpers.ts";

const REPO = 7;
const FORK = 99;
const PREVIEWS = `${APPS}/hello/previews`;

async function pullHook(w: GitWorld, hook: string, secret: string, o: { pr?: number; sha?: string; action?: string; head?: number | null; base?: number } = {}) {
  const base = o.base ?? REPO;
  const head = o.head === undefined ? REPO : o.head;
  const body = JSON.stringify({
    action: o.action ?? "opened", number: o.pr ?? 3,
    repository: { id: base, full_name: "acme/hello" },
    pull_request: { head: { sha: o.sha ?? SHA_NEW, repo: head === null ? null : { id: head } }, base: { repo: { id: base } } },
  });
  const sig = hex(await hmacSha256(secret, new TextEncoder().encode(body)));
  return w.app.fetch(new Request(`http://localhost/api/hooks/git/${hook}`, {
    method: "POST", body,
    headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": crypto.randomUUID(), "x-hub-signature-256": `sha256=${sig}` },
  }));
}

/** The host answers the PR with whatever head the test set. */
function pulls(w: GitWorld, o: { head?: () => string; fork?: boolean; state?: string } = {}) {
  const inner = w.host.fetch;
  w.host.fetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname.includes("/pulls/")) {
      return Response.json({ state: o.state ?? "open", title: "T", user: { login: "dev" }, head: { sha: o.head ? o.head() : SHA_NEW, repo: { id: o.fork ? FORK : REPO } }, base: { repo: { id: REPO } } });
    }
    return inner(input, init);
  };
  w.app.deps.fetch = (i, n) => w.host.fetch(i, n);
}

async function ready(o: { fork?: boolean; head?: () => string; state?: string } = {}) {
  const w = await gitWorld();
  const { hook, secret } = await w.link();
  pulls(w, o);
  expect((await w.owner.call("PATCH", GIT, { previews: true })).status).toBe(200);
  return { w, hook, secret };
}
const list = async (w: GitWorld) => ((await (await w.owner.call("GET", PREVIEWS)).json()) as { items: { pr: number; sha: string; held: boolean; slug: string | null; fork: boolean; approved_sha: string | null }[] }).items;

describe("previews from pull requests", () => {
  it("does nothing until turned on", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    pulls(w);
    const res = await pullHook(w, hook, secret);
    expect(((await res.json()) as { status: string }).status).toBe("ignored");
    await w.tick();
    expect(w.fake.scratchCalls).toEqual([]);
  });

  it("makes one service per PR, deploys into it, with the preview env and never production's", async () => {
    const { w, hook, secret } = await ready();
    const prod = w.fake.services.get(w.serviceId);
    if (prod) prod.env = { PROD_ONLY: "x" };
    expect((await w.owner.call("PUT", `${APPS}/hello/preview-env`, { env: { FLAG: "on" } })).status).toBe(204);
    await pullHook(w, hook, secret);
    await w.tick();
    const [p] = await list(w);
    expect(p).toMatchObject({ pr: 3, sha: SHA_NEW, held: false, fork: false });
    expect(w.fake.scratchCalls[0]).toMatchObject({ of: w.serviceId, name: "pr-3" });
    const svc = [...w.fake.services.values()].find((s) => s.view.slug === p?.slug);
    expect(svc?.env).toEqual({ FLAG: "on" });
    expect(w.fake.fromUrlCalls[0]).toMatchObject({ service: svc?.view.id, body: { activate: "after_build" } });
    await w.tick();
    expect(svc?.live).toBe(1);
    // The next push goes to the same service.
    await pullHook(w, hook, secret, { action: "synchronize", sha: SHA_OLD });
    await w.tick();
    expect(w.fake.scratchCalls).toHaveLength(1);
  });

  it("keys on the PR number, not the branch", async () => {
    const { w, hook, secret } = await ready();
    await pullHook(w, hook, secret, { pr: 3 });
    await w.tick();
    await pullHook(w, hook, secret, { pr: 4, sha: SHA_OLD });
    await w.tick();
    expect((await list(w)).map((p) => p.pr).sort()).toEqual([3, 4]);
  });

  it("caps previews per App", async () => {
    const { w, hook, secret } = await ready();
    for (let pr = 1; pr <= 6; pr++) {
      await pullHook(w, hook, secret, { pr, sha: `${pr}`.repeat(40) });
      await w.tick();
    }
    expect(w.fake.scratchCalls).toHaveLength(5);
  });

  it("ends on a runtime quota refusal with its code", async () => {
    const { w, hook, secret } = await ready();
    w.fake.scratchError = { status: 403, code: "quota_exceeded", message: "x" };
    await pullHook(w, hook, secret);
    await w.tick();
    const row = await w.app.deps.storage.db.first<{ state: string; error: string }>("SELECT state, error FROM git_deliveries");
    expect(row).toMatchObject({ state: "failed", error: "quota_exceeded" });
  });

  it("closing deletes the service through the retrying job", async () => {
    const { w, hook, secret } = await ready();
    await pullHook(w, hook, secret);
    await w.tick();
    await pullHook(w, hook, secret, { action: "closed" });
    expect(await list(w)).toEqual([]);
    expect(await w.app.deps.storage.db.first("SELECT service_id FROM pending_service_deletes")).toBeTruthy();
  });

  it("the sweep removes an expired one", async () => {
    const { w, hook, secret } = await ready();
    await pullHook(w, hook, secret);
    await w.tick();
    w.app.tick(8 * 86_400_000);
    await runJobs(w.app.deps, HOUSEKEEPING_JOBS.filter((j) => j.name === "preview_sweep"), { wallMs: 20_000, fetches: 50 });
    expect(await w.app.deps.storage.db.first("SELECT 1 AS x FROM previews")).toBeNull();
    expect(await w.app.deps.storage.db.first("SELECT service_id FROM pending_service_deletes")).toBeTruthy();
  });

  it("recreates a service the node already expired", async () => {
    let sha = SHA_NEW;
    const { w, hook, secret } = await ready({ head: () => sha });
    await pullHook(w, hook, secret);
    await w.tick();
    const [p] = await list(w);
    sha = SHA_OLD;
    const id = [...w.fake.services.values()].find((s) => s.view.slug === p?.slug)?.view.id ?? "";
    w.fake.services.delete(id);
    await pullHook(w, hook, secret, { action: "synchronize", sha: SHA_OLD });
    await w.tick();
    expect(w.fake.scratchCalls).toHaveLength(2);
    expect(await list(w)).toHaveLength(1);
  });
});

describe("numeric repo ids", () => {
  it("pins the first id and ignores another repo under the same name", async () => {
    const { w, hook, secret } = await ready();
    await pullHook(w, hook, secret, { pr: 1 });
    const res = await pullHook(w, hook, secret, { pr: 2, base: 1234, head: 1234 });
    expect(((await res.json()) as { status: string }).status).toBe("ignored");
    const row = await w.app.deps.storage.db.first<{ repo_id: number }>("SELECT repo_id FROM git_links");
    expect(row?.repo_id).toBe(REPO);
  });
});

describe("forks", () => {
  it("holds a fork: no service, no fetch", async () => {
    const { w, hook, secret } = await ready({ fork: true });
    await pullHook(w, hook, secret, { head: FORK });
    await w.tick();
    expect(await list(w)).toMatchObject([{ pr: 3, held: true, fork: true, slug: null }]);
    expect(w.fake.scratchCalls).toEqual([]);
    expect(w.fake.fromUrlCalls).toEqual([]);
  });

  it("the host's word overrides a body claiming the same repo", async () => {
    const { w, hook, secret } = await ready({ fork: true });
    await pullHook(w, hook, secret, { head: REPO });
    await w.tick();
    expect((await list(w))[0]?.held).toBe(true);
  });

  it("a deleted head repo counts as a fork", async () => {
    const { w, hook, secret } = await ready({ fork: true });
    await pullHook(w, hook, secret, { head: null });
    await w.tick();
    expect((await list(w))[0]?.held).toBe(true);
  });

  it("approval is bound to the SHA: a later commit is held again and an old approval is refused", async () => {
    let sha = SHA_NEW;
    const { w, hook, secret } = await ready({ fork: true, head: () => sha });
    await pullHook(w, hook, secret, { head: FORK });
    await w.tick();
    const approve = `${PREVIEWS}/3/approve`;
    expect((await w.owner.call("POST", approve, { sha })).status).toBe(200);
    await w.tick();
    expect(w.fake.fromUrlCalls).toHaveLength(1);
    expect((await list(w))[0]).toMatchObject({ held: false, approved_sha: SHA_NEW });

    sha = SHA_OLD;
    await pullHook(w, hook, secret, { head: FORK, action: "synchronize", sha });
    await w.tick();
    expect((await list(w))[0]).toMatchObject({ held: true, sha: SHA_OLD });
    expect(w.fake.fromUrlCalls).toHaveLength(1);
    const stale = await w.owner.call("POST", approve, { sha: SHA_NEW });
    expect(stale.status).toBe(409);
    expect((await errOf(stale)).code).toBe("preview_sha_changed");
  });

  it("a fork gets no env unless the approver said so", async () => {
    const { w, hook, secret } = await ready({ fork: true });
    await w.owner.call("PUT", `${APPS}/hello/preview-env`, { env: { FLAG: "on" } });
    await pullHook(w, hook, secret, { head: FORK });
    await w.tick();
    await w.owner.call("POST", `${PREVIEWS}/3/approve`, { sha: SHA_NEW });
    await w.tick();
    const slug = (await list(w))[0]?.slug;
    expect([...w.fake.services.values()].find((s) => s.view.slug === slug)?.env).toEqual({});
  });
});

describe("authorization", () => {
  it("a viewer lists but cannot read env, delete or approve; a developer cannot approve", async () => {
    const { w, hook, secret } = await ready({ fork: true });
    await pullHook(w, hook, secret, { head: FORK });
    await w.tick();
    const viewer = await w.user("v@example.com", "member", { default: "viewer" });
    const dev = await w.user("d@example.com", "member", { default: "developer" });
    expect((await viewer.call("GET", PREVIEWS)).status).toBe(200);
    expect((await viewer.call("GET", `${APPS}/hello/preview-env`)).status).toBe(403);
    expect((await viewer.call("PUT", `${APPS}/hello/preview-env`, { env: {} })).status).toBe(403);
    expect((await viewer.call("DELETE", `${PREVIEWS}/3`)).status).toBe(403);
    expect((await dev.call("POST", `${PREVIEWS}/3/approve`, { sha: SHA_NEW })).status).toBe(403);
  });

  it("another org's member gets 404 on every route (IDOR)", async () => {
    const { w, hook, secret } = await ready({ fork: true });
    await pullHook(w, hook, secret, { head: FORK });
    await w.tick();
    await w.addOrg("other");
    const base = "/api/orgs/other/apps/hello";
    for (const [m, p, b] of [
      ["GET", `${base}/previews`], ["DELETE", `${base}/previews/3`], ["POST", `${base}/previews/3/approve`, { sha: SHA_NEW }],
      ["GET", `${base}/preview-env`], ["PUT", `${base}/preview-env`, { env: {} }],
    ] as const) {
      expect((await w.admin.call(m, p, b)).status, `${m} ${p}`).toBe(404);
    }
    expect(await list(w)).toHaveLength(1);
  });
});
