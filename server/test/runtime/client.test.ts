/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_TIMEOUT_MS, Runtime, RuntimeError, RuntimeTimeout, RuntimeUnavailable, decodeError, isBusy, isDisabled, isNotFound, isThrottled, isUnavailable,
  sdkRtCtl, type SdkHandle,
} from "../../src/runtime/client.ts";
import { CHUNK, type WireReq, type WireRes } from "../../src/runtime/types.ts";
import { FakeRtCtl } from "../fakes/rtctl.ts";
import { runtimeAppError } from "../../src/runtime/errors.ts";

function setup() {
  const fake = new FakeRtCtl();
  const rt = new Runtime(fake);
  return { fake, rt };
}

async function err(p: Promise<unknown>): Promise<RuntimeError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RuntimeError) return e;
    throw e;
  }
  throw new Error("expected RuntimeError");
}

describe("decodeError", () => {
  it("reads the control-API envelope and Retry-After", () => {
    const e = decodeError({ status: 429, headers: { "retry-after": "3" }, body: { error: { code: "rate_limited", message: "slow", details: { a: 1 } } } });
    expect([e.status, e.code, e.message.includes("slow"), e.retryAfter, e.details]).toEqual([429, "rate_limited", true, 3, { a: 1 }]);
    expect(isThrottled(e)).toBe(true);
  });
  it("falls back to x-rt-reason, then http_<status>", () => {
    expect(decodeError({ status: 403, headers: { "x-rt-reason": "binding_denied" }, body: "binding_denied" }).code).toBe("binding_denied");
    const e = decodeError({ status: 502, headers: {}, body: "<html>" });
    expect([e.code, e.retryAfter]).toEqual(["http_502", undefined]);
  });
  it("classifies", () => {
    const mk = (status: number, code: string) => new RuntimeError(status, code, "");
    expect(isNotFound(mk(404, "not_found"))).toBe(true);
    expect(isBusy(mk(503, "queue_timeout"))).toBe(true);
    expect(isBusy(mk(503, "control_disabled"))).toBe(false);
    expect(isDisabled(mk(503, "control_disabled"))).toBe(true);
    expect(isThrottled(mk(429, "other"))).toBe(false);
  });
});

describe("Runtime over FakeRtCtl", () => {
  it("operator creates a tenant and its key; the key drives tenant calls", async () => {
    const { fake, rt } = setup();
    const t = await rt.op().createTenant({ name: "acme", plan: "free" });
    expect(t.id).toMatch(/^ten_/);
    const k = await rt.op().createTenantKey(t.id, { name: "default", scopes: ["services:read", "services:write", "deploy", "keys:write"], project_ids: [], environments: [] });
    expect(k.secret).toMatch(/^rtk_/);
    expect(k.project_ids).toBeNull();
    // empty project_ids/environments are dropped, never sent as []
    expect(fake.calls.at(-1)!.body).toEqual({ name: "default", scopes: ["services:read", "services:write", "deploy", "keys:write"] });
    const me = await rt.as(k.secret).me();
    expect(me.tenant_id).toBe(t.id);
    const svc = await rt.as(k.secret).createService({ slug: "hello", runtime: "deno" });
    expect(svc.project).toBe("default");
    const got = await rt.as(k.secret).getService(svc.id);
    expect(got.etag).toBe('"1"');
  });

  it("If-Match conflicts are 412 precondition_failed", async () => {
    const { fake, rt } = setup();
    const { key } = fake.seedTenant("a");
    const s = await rt.as(key).createService({ slug: "svc-a", runtime: "deno" });
    await rt.as(key).patchService(s.id, { name: "x" }, '"1"');
    const e = await err(rt.as(key).patchService(s.id, { name: "y" }, '"1"'));
    expect([e.status, e.code]).toEqual([412, "precondition_failed"]);
  });

  it("tenant isolation: another tenant's service is 404", async () => {
    const { fake, rt } = setup();
    const a = fake.seedTenant("a");
    const b = fake.seedTenant("b");
    const s = await rt.as(a.key).createService({ slug: "only-a", runtime: "deno" });
    expect(isNotFound(await err(rt.as(b.key).getService(s.id)))).toBe(true);
    expect((await err(rt.as(b.key).createService({ slug: "only-a", runtime: "deno" }))).code).toBe("slug_taken");
  });

  it("bad and revoked keys are 401 unauthorized", async () => {
    const { fake, rt } = setup();
    const a = fake.seedTenant("a");
    expect((await err(rt.as("rtk_nope_00").me())).code).toBe("unauthorized");
    await rt.op().revokeTenantKey(a.tenant.id, a.keyId);
    expect((await err(rt.as(a.key).me())).status).toBe(401);
  });

  it("key scopes: project_ids + environments narrow; escalation is refused", async () => {
    const { fake, rt } = setup();
    const a = fake.seedTenant("a");
    const prj = await rt.as(a.key).createProject({ slug: "web", environments: ["production", "staging"] });
    const restricted = await rt.as(a.key).createKey({ scopes: ["services:read", "keys:write", "sockets:write"], project_ids: [prj.id], environments: ["staging"] });
    expect([restricted.project_ids, restricted.environments]).toEqual([[prj.id], ["staging"]]);
    const esc = await err(rt.as(restricted.secret).createKey({ scopes: ["deploy"] }));
    expect([esc.status, esc.code, esc.details]).toEqual([403, "insufficient_scope", { reason: "escalation" }]);
    const esc2 = await err(rt.as(restricted.secret).createKey({ scopes: ["services:read"], environments: ["production"] }));
    expect(esc2.details).toEqual({ reason: "escalation" });
    const child = await rt.as(restricted.secret).createKey({ scopes: ["services:read"] });
    expect([child.project_ids, child.environments]).toEqual([[prj.id], ["staging"]]);
    expect((await err(rt.as(restricted.secret).createService({ slug: "nope", runtime: "deno" }))).code).toBe("insufficient_scope");
    expect((await err(rt.as(a.key).createKey({ scopes: ["bogus" as never] }))).code).toBe("validation_failed");
  });

  it("missing scope is 403 insufficient_scope", async () => {
    const { fake, rt } = setup();
    const a = fake.seedTenant("a");
    const ro = await rt.as(a.key).createKey({ scopes: ["services:read"] });
    expect((await err(rt.as(ro.secret).createService({ slug: "x-y", runtime: "deno" }))).code).toBe("insufficient_scope");
    expect((await err(rt.as(ro.secret).listKeys())).code).toBe("insufficient_scope");
  });

  it("binding allow-list: op cannot reach tenant paths, tenant cannot reach operator paths", async () => {
    const { fake, rt } = setup();
    const a = fake.seedTenant("a");
    const e1 = await err(rt.op().listServices());
    expect([e1.status, e1.code]).toEqual([403, "binding_denied"]);
    const e2 = await err(rt.as(a.key).nodeStatus());
    expect(e2.code).toBe("binding_denied");
    expect((await err(rt.as(a.key).call({ method: "GET", path: "/v1/services/../tenants" }))).code).toBe("binding_denied");
    expect((await rt.as(a.key).tenantUsage(a.tenant.id))).toEqual([]);
  });

  it("injected failures: envelope and binding refusal shapes", async () => {
    const { fake, rt } = setup();
    fake.failNext({ status: 503, code: "queue_timeout", retryAfter: 1 });
    const e = await err(rt.op().nodeStatus());
    expect([isBusy(e), e.retryAfter]).toEqual([true, 1]);
    fake.failNext({ status: 429, reason: "rate_limited" });
    expect(isThrottled(await err(rt.op().nodeStatus()))).toBe(true);
    fake.failNext({ status: 502, reason: "binding_upstream" });
    await expect(rt.op().nodeStatus()).rejects.toBeInstanceOf(RuntimeUnavailable);
    expect((await rt.op().nodeStatus()).mode).toBe("normal");
  });

  it("versions, live, logs with std:log fields", async () => {
    const { fake, rt } = setup();
    const a = fake.seedTenant("a");
    const s = await rt.as(a.key).createService({ slug: "app-1", runtime: "deno" });
    const v = await rt.as(a.key).uploadVersion(s.id, "export default {}", "application/typescript", { activate: true });
    expect(v.version).toBe(1);
    expect(fake.calls.at(-1)!.query).toEqual({ activate: "1" });
    expect((await rt.as(a.key).getService(s.id)).value.live_version).toBe(1);
    expect((await rt.as(a.key).versionSource(s.id, 1)).body).toBe("export default {}");
    fake.emitLog(s.id, "hello", { user: "u1" });
    fake.emitLog(s.id, "again");
    const p1 = await rt.as(a.key).logs(s.id);
    expect(p1.items.map((l) => [l.seq, l.msg, l.fields])).toEqual([[1, "hello", { user: "u1" }], [2, "again", undefined]]);
    fake.emitLog(s.id, "third");
    const p2 = await rt.as(a.key).logs(s.id, { cursor: p1.next_cursor! });
    expect(p2.items.map((l) => l.msg)).toEqual(["third"]);
    fake.failBuild(s.id);
    expect((await err(rt.as(a.key).setLive(s.id, 1))).code).toBe("version_not_ready");
  });

  it("env, secrets, schedules (+once), queue, dlq, hosts", async () => {
    const { fake, rt } = setup();
    const a = fake.seedTenant("a");
    const c = rt.as(a.key);
    const s = await c.createService({ slug: "app-2", runtime: "deno" });
    expect(await c.putEnv(s.id, { A: "1" })).toEqual({ A: "1" });
    await c.putSecret(s.id, "TOKEN", "x");
    expect((await c.listSecrets(s.id)).map((x) => x.name)).toEqual(["TOKEN"]);
    const sc = await c.createSchedule(s.id, { kind: "interval", every_seconds: 60 });
    expect((await c.updateSchedule(s.id, sc.id, { kind: "cron", cron: "* * * * *" })).cron).toBe("* * * * *");
    const once = fake.addOnceSchedule(s.id, 123);
    expect((await c.listOnceSchedules(s.id)).items).toEqual([{ id: once, kind: "once", run_at: 123 }]);
    expect(fake.calls.at(-1)!.query).toEqual({ limit: "200" });
    await c.deleteSchedule(s.id, once);
    expect((await err(c.createSchedule(s.id, { kind: "weird" }))).code).toBe("validation_failed");
    await c.enqueue(s.id, { body: { a: 1 } });
    fake.deadLetter(s.id, { b: 2 });
    expect((await c.queueStats(s.id))).toMatchObject({ depth: 1, dlq: 1 });
    expect((await c.redriveDLQ(s.id)).redriven).toBe(1);
    const h = await rt.op().putHost(s.id, "App.Example.com");
    expect([h.host, h.status]).toEqual(["app.example.com", "active"]);
    expect((await c.listHosts(s.id)).length).toBe(1);
    await c.deleteService(s.id);
    expect(fake.hosts.size).toBe(0);
  });

  it("delete tenant: not empty without purge", async () => {
    const { fake, rt } = setup();
    const a = fake.seedTenant("a");
    await rt.as(a.key).createService({ slug: "app-3", runtime: "deno" });
    expect((await err(rt.op().deleteTenant(a.tenant.id))).code).toBe("tenant_not_empty");
    await rt.op().deleteTenant(a.tenant.id, true);
    expect(isNotFound(await err(rt.op().getTenant(a.tenant.id)))).toBe(true);
  });

  it("projects: environments and conflicts", async () => {
    const { fake, rt } = setup();
    const c = rt.as(fake.seedTenant("a").key);
    const p = await c.createProject({ slug: "shop", environments: ["production", "staging"] });
    expect((await err(c.createProject({ slug: "shop" }))).code).toBe("project_slug_taken");
    await c.createService({ slug: "shop-api", runtime: "deno", project: "shop", environment: "staging" });
    expect((await err(c.updateProject(p.id, { environments: ["production"] }))).status).toBe(409);
    expect((await err(c.deleteProject("shop"))).code).toBe("project_not_empty");
    expect((await c.listServices({ project: "shop", environment: "staging" })).items.length).toBe(1);
  });
});

describe("sdkRtCtl wire + chunking", () => {
  // A stand-in for sdk("rtctl") that answers from a FakeRtCtl and chunks like mod.ts.
  function handle(fake: FakeRtCtl, log: string[]) {
    const store = new Map<string, string>();
    const answer = async (scope: "op" | "tenant", w: WireReq): Promise<WireRes> => {
      let body = w.body;
      if (w.bodyRef) body = Array.from({ length: w.bodyRef.parts }, (_, i) => store.get(`in:${w.bodyRef!.id}:${i}`)!).join("");
      const req = {
        method: w.method, path: w.path, query: w.query, headers: { ...w.headers, ...(w.contentType ? { "content-type": w.contentType } : {}) },
        body: body !== undefined && w.contentType === "application/json" ? JSON.parse(body) : body,
      };
      const res = scope === "op" ? await fake.op(req) : await fake.tenant(w.key!, req);
      const text = res.body === null ? "" : typeof res.body === "string" ? res.body : JSON.stringify(res.body);
      if (text.length <= CHUNK) return { status: res.status, headers: res.headers, body: text };
      const parts = Math.ceil(text.length / CHUNK);
      for (let i = 0; i < parts; i++) store.set(`out:x:${i}`, text.slice(i * CHUNK, (i + 1) * CHUNK));
      return { status: res.status, headers: res.headers, chunked: { id: "x", parts } };
    };
    const h: SdkHandle = {
      op: async (a) => (log.push("op"), answer("op", a as WireReq)),
      tenant: async (a) => (log.push("tenant"), answer("tenant", a as WireReq)),
      put: async (a) => {
        const { id, index, data } = a as { id: string; index: number; data: string };
        log.push(`put${index}`);
        expect(data.length).toBeLessThanOrEqual(CHUNK);
        store.set(`in:${id}:${index}`, data);
        return { ok: true };
      },
      get: async (a) => {
        const { id, index } = a as { id: string; index: number };
        log.push(`get${index}`);
        return { data: store.get(`out:${id}:${index}`) };
      },
    };
    return h;
  }

  it("small calls are one SDK call; JSON parsed by content-type; 204 is null", async () => {
    const fake = new FakeRtCtl();
    const log: string[] = [];
    const rt = new Runtime(sdkRtCtl(handle(fake, log)));
    const t = await rt.op().createTenant({ name: "acme", plan: "free" });
    expect(t.name).toBe("acme");
    expect(await rt.op().deleteTenant(t.id)).toBeNull();
    expect(log).toEqual(["op", "op"]);
  });

  it("bodies over 200 KiB go up in put parts and come back in get parts", async () => {
    const fake = new FakeRtCtl();
    const log: string[] = [];
    const rt = new Runtime(sdkRtCtl(handle(fake, log)));
    const a = fake.seedTenant("a");
    const s = await rt.as(a.key).createService({ slug: "big-1", runtime: "deno" });
    const src = "// " + "x".repeat(400 * 1024);
    log.length = 0;
    await rt.as(a.key).uploadVersion(s.id, src, "application/typescript");
    expect(log).toEqual(["put0", "put1", "put2", "tenant"]);
    log.length = 0;
    const got = await rt.as(a.key).versionSource(s.id, 1);
    expect(got.body).toBe(src);
    expect(log).toEqual(["tenant", "get0", "get1", "get2"]);
  });

  it("binding refusals pass through as RuntimeError with the reason", async () => {
    const fake = new FakeRtCtl();
    const rt = new Runtime(sdkRtCtl(handle(fake, [])));
    expect((await err(rt.op().listServices())).code).toBe("binding_denied");
  });

  it("an SdkError (thrown) becomes RuntimeUnavailable unless already typed", async () => {
    const rt = new Runtime(sdkRtCtl({ op: async () => { throw Object.assign(new Error("sdk_unavailable"), { code: "sdk_unavailable" }); } }));
    const e = await rt.op().nodeStatus().catch((x) => x);
    expect(isUnavailable(e)).toBe(true);
  });
});

describe("call deadline", () => {
  const hanging = { op: () => new Promise<never>(() => {}), tenant: () => new Promise<never>(() => {}) };

  it("defaults to 10 s and rejects a hung call with RuntimeTimeout", async () => {
    expect(DEFAULT_RUNTIME_TIMEOUT_MS).toBe(10_000);
    const e = await new Runtime(hanging, { timeoutMs: 15 }).as("k").getProject("p").catch((x) => x);
    expect(e).toBeInstanceOf(RuntimeTimeout);
    expect(isUnavailable(e)).toBe(true);
    expect(runtimeAppError(e)).toMatchObject({ status: 504, code: "runtime_timeout" });
  });

  it("takes the deadline from the transport when no option is given; 0 disables it", async () => {
    const e = await new Runtime({ ...hanging, timeoutMs: 15 }).op().nodeStatus().catch((x) => x);
    expect(e).toBeInstanceOf(RuntimeTimeout);
    const fake = new FakeRtCtl();
    const ok = await new Runtime(fake, { timeoutMs: 0 }).op().nodeStatus();
    expect(ok).toBeTruthy();
  });
});
