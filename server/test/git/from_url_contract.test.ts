// The console's from-url call against the rules of the runtime's route (crates/rt-api/src/from_url.rs), which
// FakeRtCtl enforces: meta limits, refused headers, idempotent replay, and a 202 before any download.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Runtime } from "../../src/runtime/client.ts";
import { FakeRtCtl } from "../fakes/rtctl.ts";
import { delivery, gitWorld, SHA_NEW } from "./helpers.ts";

afterEach(() => vi.useRealTimers());

const svcIn = async (fake: FakeRtCtl) => {
  const { key } = fake.seedTenant("t");
  const r = await fake.tenant(key, { method: "POST", path: "/v1/services", body: { slug: "svc", runtime: "deno", project: "default", environment: "production" } });
  return { key, id: (r.body as { id: string }).id };
};
const post = (fake: FakeRtCtl, key: string, id: string, body: Record<string, unknown>, idem = "k1") =>
  fake.tenant(key, { method: "POST", path: `/v1/services/${id}/versions/from-url`, body, headers: { "idempotency-key": idem } });
const URL_OK = "https://api.github.com/repos/a/b/tarball/abc";

describe("FakeRtCtl mirrors the from-url route", () => {
  it("always answers 202 and takes activate null as absent", async () => {
    const fake = new FakeRtCtl();
    const { key, id } = await svcIn(fake);
    expect((await post(fake, key, id, { url: URL_OK, compile: "eager", activate: null }, "a")).status).toBe(202);
    expect((await post(fake, key, id, { url: URL_OK, compile: "lazy" }, "b")).status).toBe(202);
  });

  it("refuses what the route refuses", async () => {
    const fake = new FakeRtCtl();
    const { key, id } = await svcIn(fake);
    const bad: Record<string, unknown>[] = [
      { url: "not a url" },
      { url: "http://example.com/a.tgz" },
      { url: URL_OK, activate: "now" },
      { url: URL_OK, compile: "lazy", activate: "after_build" },
      { url: URL_OK, strip_components: 17 },
      { url: URL_OK, headers: { host: "x" } },
      { url: URL_OK, headers: { "x-rt-tenant": "x" } },
      { url: URL_OK, meta: { git: { sha: "nothex" } } },
      { url: URL_OK, meta: { git: { author: "é".repeat(129) } } },
      { url: URL_OK, meta: { git: { message: "m".repeat(1025) } } },
      { url: URL_OK, meta: { git: { ref: "a\nb" } } },
      { url: URL_OK, meta: { git: { repo: "https://u:p@host/r" } } },
      { url: URL_OK, meta: { git: { extra: "x" } } },
      { url: URL_OK, meta: { other: 1 } },
    ];
    for (const [i, b] of bad.entries()) expect((await post(fake, key, id, b, `k${i}`)).status, JSON.stringify(b)).toBe(422);
  });

  it("replays by key, ignoring the query and header values, and refuses a different request", async () => {
    const fake = new FakeRtCtl();
    const { key, id } = await svcIn(fake);
    const first = await post(fake, key, id, { url: `${URL_OK}?sig=1`, headers: { authorization: "a" } });
    const again = await post(fake, key, id, { url: `${URL_OK}?sig=2`, headers: { authorization: "b" } });
    expect(again.body).toEqual(first.body);
    expect(fake.services.get(id)?.versions).toHaveLength(1);
    const other = await post(fake, key, id, { url: URL_OK, activate: "after_build", headers: { authorization: "b" } });
    expect(other.status).toBe(422);
    expect((other.body as { error: { code: string } }).error.code).toBe("idempotency_mismatch");
  });

  it("stores no failure: a retry of a refused fetch fetches again", async () => {
    const fake = new FakeRtCtl();
    const { key, id } = await svcIn(fake);
    fake.fromUrlError = { status: 502, code: "fetch_failed", message: "x" };
    expect((await post(fake, key, id, { url: URL_OK })).status).toBe(502);
    fake.fromUrlError = null;
    expect((await post(fake, key, id, { url: URL_OK })).status).toBe(202);
  });
});

describe("from-url answers before the fetch", () => {
  it("answers on the ordinary deadline with fetching and no digest", async () => {
    const fake = new FakeRtCtl();
    const { key, id } = await svcIn(fake);
    fake.fromUrlHold = true;
    const v = await new Runtime(fake).as(key).fromUrl(id, { url: URL_OK, strip_components: 1, compile: "eager", activate: null }, "slow");
    expect(v).toMatchObject({ version: 1, build_state: "fetching", source_digest: null });
  });

  it("a delivery waits through fetching, however long, and deploys one version", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    w.host.head = SHA_NEW;
    w.fake.fromUrlHold = true;
    await w.push(hook, secret, SHA_NEW);
    await w.tick();
    expect((await delivery(w, SHA_NEW))?.state).toBe("building");
    await w.tick();
    expect((await delivery(w, SHA_NEW))?.state).toBe("building");
    w.fake.releaseFetches();
    await w.tick();
    expect((await delivery(w, SHA_NEW))?.state).toBe("deployed");
    expect(w.fake.fromUrlCalls).toHaveLength(1);
  });

  it.each(["fetch_failed", "egress_denied", "egress_quota", "too_large", "validation_failed", "invalid_artifact", "internal"])("a fetch ending in %s fails the delivery with that code", async (code) => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    w.host.head = SHA_NEW;
    w.fake.fromUrlFailure = code;
    await w.push(hook, secret, SHA_NEW);
    await w.tick();
    await w.tick();
    expect(await delivery(w, SHA_NEW)).toMatchObject({ state: "failed", error: code });
    // Never deployed, so a new push of this commit may try again.
    expect(await w.app.deps.storage.db.first("SELECT 1 AS x FROM git_refs")).toBeNull();
  });

  it("a build_quota refusal is retried, a refused key is not", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    w.host.head = SHA_NEW;
    w.fake.fromUrlError = { status: 429, code: "build_quota", message: "x" };
    await w.push(hook, secret, SHA_NEW);
    await w.tick();
    expect(await delivery(w, SHA_NEW)).toMatchObject({ state: "queued", error: "build_quota" });
    w.fake.fromUrlError = { status: 403, code: "insufficient_scope", message: "x" };
    w.app.tick(600_000);
    await w.tick();
    expect(await delivery(w, SHA_NEW)).toMatchObject({ state: "failed", error: "insufficient_scope" });
  });

  it("a changed request on retry takes a new key rather than failing on idempotency_mismatch", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    w.host.head = SHA_NEW;
    await w.push(hook, secret, SHA_NEW);
    await w.tick();
    const firstKey = w.fake.fromUrlCalls[0]?.idempotencyKey;
    await w.app.deps.storage.db.run("UPDATE git_deliveries SET state = 'queued', next_at = 0, deployed_at = NULL");
    await w.app.deps.storage.db.run("DELETE FROM git_refs");
    await w.app.deps.storage.db.run("UPDATE git_links SET auto_promote = 1 - auto_promote");
    await w.tick();
    expect(w.fake.fromUrlCalls[1]?.idempotencyKey).not.toBe(firstKey);
    expect((await delivery(w, SHA_NEW))?.state).not.toBe("failed");
  });

  it("caps a long non-ASCII author by bytes, so a commit never fails on meta", async () => {
    const w = await gitWorld();
    const { hook, secret } = await w.link();
    w.host.head = SHA_NEW;
    w.host.author = "漢".repeat(100);
    await w.push(hook, secret, SHA_NEW);
    await w.tick();
    expect((await delivery(w, SHA_NEW))?.state).toBe("building");
    const meta = w.fake.fromUrlCalls[0]?.body.meta as { git: { author: string } };
    expect(new TextEncoder().encode(meta.git.author).length).toBeLessThanOrEqual(256);
    expect(meta.git.author).not.toContain("�");
  });
});
