import { describe, expect, it } from "vitest";
import { APPS, createApp, errOf, sdkHandle, world } from "./helpers.ts";
import { FakeRtCtl } from "../fakes/rtctl.ts";
import { sdkRtCtl } from "../../src/runtime/client.ts";
import type { CtlReq, CtlRes, RtCtl } from "../../src/runtime/types.ts";
import { isCidr } from "../../src/apps/service.ts";
import { checkPath, unpack } from "../../src/apps/source.ts";

const svcOf = (w: Awaited<ReturnType<typeof world>>, slug: string) => [...w.fake.services.values()].find((s) => s.view.slug === slug)?.view.id ?? "";

describe("apps CRUD + ETag", () => {
  it("create → 201 + ETag; get; list paged; template is live v1", async () => {
    const w = await world();
    const { etag, body } = await createApp(w.admin);
    expect(etag).toMatch(/^".+"$/);
    expect(body).toMatchObject({ slug: "hello", project: "default", environment: "production", live_version: 1, runtime: "deno", etag, url: "/s/hello/" });
    expect(body.limits).toMatchObject({ source: "profile" });
    const g = await w.admin.call("GET", `${APPS}/hello`);
    expect(g.status).toBe(200);
    expect(g.headers.get("etag")).toBe(etag);
    await createApp(w.admin, "second");
    const p1 = await w.admin.call("GET", `${APPS}?limit=1`);
    const page = (await p1.json()) as { items: { slug: string }[]; next_cursor: string | null };
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).toBe("1");
    const p2 = (await (await w.admin.call("GET", `${APPS}?limit=1&cursor=1`)).json()) as { next_cursor: string | null };
    expect(p2.next_cursor).toBeNull();
    // the org's hidden default key was used (tenant scope)
    expect(w.fake.calls.every((c) => c.scope === "tenant" || c.path.startsWith("/v1/tenants"))).toBe(true);
  });

  it("create errors: slug_taken, unknown template/env 422, missing fields 422, plan_limit", async () => {
    const w = await world();
    await createApp(w.admin);
    const taken = await w.admin.call("POST", APPS, { project: "default", environment: "production", slug: "hello", template: "http" });
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "slug_taken", message: "This app name is taken on this runtime" });
    const tpl = await w.admin.call("POST", APPS, { project: "default", environment: "production", slug: "x1", template: "nope" });
    expect(tpl.status).toBe(422);
    expect((await errOf(tpl)).details).toEqual({ fields: { template: "not_one_of" } });
    const env = await w.admin.call("POST", APPS, { project: "default", environment: "staging", slug: "x2", template: "http" });
    expect((await errOf(env)).details).toEqual({ fields: { environment: "not_one_of" } });
    const miss = await w.admin.call("POST", APPS, { project: "default" });
    expect(miss.status).toBe(422);
    w.fake.plans.set("free", { maxServices: 2 });
    await createApp(w.admin, "x3");
    const lim = await w.admin.call("POST", APPS, { project: "default", environment: "production", slug: "x4", template: "http" });
    expect(lim.status).toBe(403);
    expect((await errOf(lim)).code).toBe("plan_limit");
  });

  it("slug held by another org's tenant is 404 here", async () => {
    const w = await world();
    await w.addOrg("other");
    await w.app.deps.storage.db.run("INSERT INTO members (org_id, user_id, role, created_at) SELECT 'org_other', user_id, 'owner', 0 FROM members WHERE org_id = 'org_acme' LIMIT 1");
    await createApp(w.admin);
    const r = await w.admin.call("GET", "/api/orgs/other/apps/hello");
    expect(r.status).toBe(404);
  });

  it("PATCH needs If-Match (428), stale → 409, good etag → 200 + new etag; validation 422", async () => {
    const w = await world();
    const { etag } = await createApp(w.admin);
    const no = await w.admin.call("PATCH", `${APPS}/hello`, { name: "Hello" });
    expect(no.status).toBe(428);
    expect((await errOf(no)).code).toBe("precondition_required");
    const okr = await w.admin.call("PATCH", `${APPS}/hello`, { name: "Hello", ingress: { ip_allow: ["10.0.0.0/8"] }, call: { allowed_callers: ["a"] } }, { "if-match": etag });
    expect(okr.status).toBe(200);
    const next = okr.headers.get("etag");
    expect(next).not.toBe(etag);
    const b = (await okr.json()) as { name: string; ingress: unknown; etag: string };
    expect(b).toMatchObject({ name: "Hello", ingress: { ip_allow: ["10.0.0.0/8"] }, etag: next });
    const stale = await w.admin.call("PATCH", `${APPS}/hello`, { name: "Again" }, { "if-match": etag });
    expect(stale.status).toBe(409);
    expect((await errOf(stale)).code).toBe("stale");
    const bad = await w.admin.call("PATCH", `${APPS}/hello`, { access: "open", ingress: { ip_allow: ["nope"] }, scaling: { min_instances: 3, max_instances: 1 } }, { "if-match": next ?? "" });
    expect(bad.status).toBe(422);
    expect((await errOf(bad)).details).toEqual({ fields: { access: "not_one_of", "ingress.ip_allow[0]": "invalid_format", "scaling.min_instances": "out_of_range" } });
  });

  it("delete → 204 then 404; audit rows written", async () => {
    const w = await world();
    await createApp(w.admin);
    expect((await w.admin.call("DELETE", `${APPS}/hello`)).status).toBe(204);
    expect((await w.admin.call("GET", `${APPS}/hello`)).status).toBe(404);
    const rows = await w.app.deps.storage.db.all<{ action: string }>("SELECT action FROM audit ORDER BY ts");
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["app.create", "app.delete"]));
  });

  it("authz: non-member 404, viewer reads but cannot write (403), ungranted project 404, developer can deploy", async () => {
    const w = await world();
    await createApp(w.admin);
    const out = await w.user("out@example.com", null);
    expect((await out.call("GET", APPS)).status).toBe(404);
    const viewer = await w.user("view@example.com", "member", { default: "viewer" });
    expect((await viewer.call("GET", `${APPS}/hello`)).status).toBe(200);
    const vc = await viewer.call("POST", APPS, { project: "default", environment: "production", slug: "v1", template: "http" });
    expect(vc.status).toBe(403);
    expect((await viewer.call("PUT", `${APPS}/hello/secrets/API_KEY`, { value: "x" })).status).toBe(403);
    const none = await w.user("none@example.com", "member");
    expect((await none.call("GET", `${APPS}/hello`)).status).toBe(404);
    const list = (await (await none.call("GET", APPS)).json()) as { items: unknown[] };
    expect(list.items).toEqual([]);
    const dev = await w.user("dev@example.com", "member", { default: "developer" });
    expect((await dev.call("PUT", `${APPS}/hello/env`, { env: { A: "1" } })).status).toBe(200);
    expect((await dev.call("PUT", `${APPS}/hello/secrets/API_KEY`, { value: "x" })).status).toBe(403);
    expect((await dev.call("GET", `${APPS}/hello/export`)).status).toBe(403);
  });

  it("runtime 429 build_quota passes through with Retry-After; unreachable → 502", async () => {
    const w = await world();
    await createApp(w.admin);
    w.fake.failNext({ status: 429, code: "build_quota", retryAfter: 7, match: (r) => r.path.endsWith("/versions") && r.method === "POST" });
    const g = (await w.admin.call("GET", `${APPS}/hello`)).headers.get("etag") ?? "";
    const r = await w.admin.call("PUT", `${APPS}/hello/files`, { entry: "main.ts", files: { "main.ts": "x" } }, { "if-match": g });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("7");
    expect(await errOf(r)).toMatchObject({ code: "build_quota", details: { retry_after: 7 } });
    w.fake.failNext({ status: 502, reason: "binding_upstream" });
    expect((await w.admin.call("GET", `${APPS}/hello`)).status).toBe(502);
  });
});

describe("files and versions", () => {
  it("GET files of the live template; ?version bad → 422", async () => {
    const w = await world();
    await createApp(w.admin);
    const r = await w.admin.call("GET", `${APPS}/hello/files`);
    expect(r.status).toBe(200);
    const f = (await r.json()) as { version: number; entry: string; kind: string; files: Record<string, string>; read_only: boolean };
    expect(f).toMatchObject({ version: 1, entry: "main.ts", kind: "ts", read_only: false });
    expect(f.files["main.ts"]).toContain("hello");
    expect((await w.admin.call("GET", `${APPS}/hello/files?version=0`)).status).toBe(422);
    expect((await w.admin.call("GET", `${APPS}/hello/files?version=9`)).status).toBe(404);
  });

  it("PUT files round-trips 3 MB through the chunked SDK transport", async () => {
    const fake = new FakeRtCtl();
    const log: string[] = [];
    const w = await world({ fake, rtctl: sdkRtCtl(sdkHandle(fake, log)) });
    const { etag } = await createApp(w.admin);
    const files: Record<string, string> = { "main.ts": "export default { fetch: () => new Response('ok') };" };
    for (let i = 0; i < 4; i++) files[`lib/part${i}.ts`] = `// ${i}\n` + "é".repeat(370_000); // ~740 KB each (UTF-8)
    const total = Object.values(files).reduce((n, s) => n + new TextEncoder().encode(s).length, 0);
    expect(total).toBeGreaterThan(2_900_000);
    const put = await w.admin.call("PUT", `${APPS}/hello/files`, { entry: "main.ts", files }, { "if-match": etag });
    expect(put.status, await put.clone().text()).toBe(200);
    const saved = (await put.json()) as { version: { version: number; live: boolean; author: { name: string } }; etag: string };
    expect(saved.version).toMatchObject({ version: 2, live: true, author: { name: "Admin" } });
    expect(put.headers.get("etag")).toBe(saved.etag);
    expect(log.filter((l) => l.startsWith("put")).length).toBeGreaterThan(5);
    const got = (await (await w.admin.call("GET", `${APPS}/hello/files`)).json()) as { version: number; kind: string; files: Record<string, string> };
    expect(log.some((l) => l.startsWith("chunked-out"))).toBe(true);
    expect(got.version).toBe(2);
    expect(got.kind).toBe("bundle");
    expect(got.files).toEqual(files);
  });

  it("PUT files: 428 without If-Match, 409 stale, 422 bad path/entry/oversize file, build_failed keeps live", async () => {
    const w = await world();
    const { etag } = await createApp(w.admin);
    const body = { entry: "main.ts", files: { "main.ts": "x" } };
    expect((await w.admin.call("PUT", `${APPS}/hello/files`, body)).status).toBe(428);
    const bad = await w.admin.call("PUT", `${APPS}/hello/files`, { entry: "nope.ts", files: { "../x.ts": "a", "big.ts": "a".repeat((1 << 20) + 1) } }, { "if-match": etag });
    expect(bad.status).toBe(422);
    expect((await errOf(bad)).details).toEqual({ fields: { "files.../x.ts": "invalid_format", "files.big.ts": "too_long", entry: "not_one_of" } });
    // a build that ends failed is never activated
    w.fake.failNext({ status: 0, match: () => false }); // no-op
    const svc = svcOf(w, "hello");
    const orig = w.fake.tenant.bind(w.fake);
    w.fake.tenant = async (k, r) => {
      const res = await orig(k, r);
      if (r.method === "POST" && r.path.endsWith("/versions")) w.fake.failBuild(svc, [{ message: "boom", line: 1 }]);
      if (r.method === "POST" && r.path.endsWith("/versions")) return { ...res, body: { ...(res.body as object), build_state: "building" } };
      return res;
    };
    const failed = await w.admin.call("PUT", `${APPS}/hello/files`, body, { "if-match": etag });
    expect(failed.status).toBe(422);
    expect(await errOf(failed)).toMatchObject({ code: "build_failed", details: { version: 2, reason: "build_failed", diagnostics: [{ message: "boom", line: 1 }] } });
    w.fake.tenant = orig;
    expect(((await (await w.admin.call("GET", `${APPS}/hello`)).json()) as { live_version: number }).live_version).toBe(1);
    const stale = await w.admin.call("PUT", `${APPS}/hello/files`, body, { "if-match": '"999"' });
    expect(stale.status).toBe(409);
  });

  it("versions newest first with authors; live promote; version_not_ready; build logs; rebuild 202", async () => {
    const w = await world();
    const { etag } = await createApp(w.admin);
    const put = await w.admin.call("PUT", `${APPS}/hello/files`, { entry: "main.ts", files: { "main.ts": "a" } }, { "if-match": etag });
    const e2 = ((await put.json()) as { etag: string }).etag;
    const vs = (await (await w.admin.call("GET", `${APPS}/hello/versions`)).json()) as { items: { version: number; live: boolean; author: unknown }[] };
    expect(vs.items.map((v) => [v.version, v.live])).toEqual([[2, true], [1, false]]);
    expect(vs.items[0]?.author).toMatchObject({ name: "Admin" });
    expect(vs.items[1]?.author).toBeNull();
    expect((await w.admin.call("PUT", `${APPS}/hello/live`, { version: 1 })).status).toBe(428);
    const live = await w.admin.call("PUT", `${APPS}/hello/live`, { version: 1 }, { "if-match": e2 });
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ live_version: 1 });
    expect((await w.admin.call("PUT", `${APPS}/hello/live`, { version: 2 }, { "if-match": e2 })).status).toBe(409);
    const svc = svcOf(w, "hello");
    w.fake.failBuild(svc);
    const e3 = live.headers.get("etag") ?? "";
    const nr = await w.admin.call("PUT", `${APPS}/hello/live`, { version: 2 }, { "if-match": e3 });
    expect(nr.status).toBe(409);
    expect((await errOf(nr)).code).toBe("version_not_ready");
    const s = w.fake.service(svc);
    if (!s) throw new Error("no svc");
    s.logs.push({ seq: ++s.logSeq, ts: 1, level: "info", service_id: svc, kind: "build", msg: "compiling", version: 2 });
    s.logs.push({ seq: ++s.logSeq, ts: 1, level: "info", service_id: svc, kind: "build", msg: "other", version: 1 });
    const bl = (await (await w.admin.call("GET", `${APPS}/hello/versions/2/build-logs`)).json()) as { items: { msg: string; service_id?: string }[] };
    expect(bl.items.map((l) => l.msg)).toEqual(["compiling"]);
    expect(bl.items[0]).not.toHaveProperty("service_id");
    expect((await w.admin.call("GET", `${APPS}/hello/versions/9/build-logs`)).status).toBe(404);
    const rb = await w.admin.call("POST", `${APPS}/hello/versions/2/rebuild`);
    expect(rb.status).toBe(202);
    expect((await w.admin.call("POST", `${APPS}/hello/versions/x/rebuild`)).status).toBe(422);
  });
});

describe("config: env, secrets, schedules, queue", () => {
  it("env replace; secrets names only; delete unknown 404", async () => {
    const w = await world();
    await createApp(w.admin);
    const put = await w.admin.call("PUT", `${APPS}/hello/env`, { env: { A: "1", B: "2" } });
    expect(await put.json()).toEqual({ env: { A: "1", B: "2" } });
    expect(await (await w.admin.call("GET", `${APPS}/hello/env`)).json()).toEqual({ env: { A: "1", B: "2" } });
    expect((await w.admin.call("PUT", `${APPS}/hello/env`, { env: { "bad key": "1" } })).status).toBe(422);
    expect((await w.admin.call("PUT", `${APPS}/hello/secrets/API_KEY`, { value: "s3cret" })).status).toBe(204);
    const list = await (await w.admin.call("GET", `${APPS}/hello/secrets`)).text();
    expect(list).toContain("API_KEY");
    expect(list).not.toContain("s3cret");
    expect((await w.admin.call("DELETE", `${APPS}/hello/secrets/API_KEY`)).status).toBe(204);
    expect((await w.admin.call("DELETE", `${APPS}/hello/secrets/API_KEY`)).status).toBe(404);
    expect((await w.admin.call("PUT", `${APPS}/hello/secrets/API_KEY`, {})).status).toBe(422);
  });

  it("schedules CRUD, merge-patch, once list, plan_limit", async () => {
    const w = await world();
    await createApp(w.admin);
    const c = await w.admin.call("POST", `${APPS}/hello/schedules`, { kind: "interval", every_seconds: 60, payload: { a: 1 } });
    expect(c.status).toBe(201);
    const sch = (await c.json()) as { id: string };
    const p = await w.admin.call("PATCH", `${APPS}/hello/schedules/${sch.id}`, { enabled: false });
    expect(p.status).toBe(200);
    expect(await p.json()).toMatchObject({ kind: "interval", every_seconds: 60, enabled: false, payload: { a: 1 } });
    expect((await w.admin.call("PATCH", `${APPS}/hello/schedules/sch_nope`, { enabled: true })).status).toBe(404);
    expect((await w.admin.call("POST", `${APPS}/hello/schedules`, { kind: "weekly" })).status).toBe(422);
    const items = (await (await w.admin.call("GET", `${APPS}/hello/schedules`)).json()) as { items: unknown[] };
    expect(items.items).toHaveLength(1);
    const once = w.fake.addOnceSchedule(svcOf(w, "hello"), 123);
    expect(await (await w.admin.call("GET", `${APPS}/hello/schedules/once`)).json()).toEqual({ items: [{ id: once, kind: "once", run_at: 123 }] });
    expect((await w.admin.call("DELETE", `${APPS}/hello/schedules/${sch.id}`)).status).toBe(204);
    w.fake.plans.set("free", { maxSchedules: 0 });
    const lim = await w.admin.call("POST", `${APPS}/hello/schedules`, { kind: "cron", cron: "* * * * *" });
    expect(lim.status).toBe(403);
    expect((await errOf(lim)).code).toBe("plan_limit");
  });

  it("queue stats, enqueue 201, dlq list/redrive/purge, queue_full 429", async () => {
    const w = await world();
    await createApp(w.admin);
    const e = await w.admin.call("POST", `${APPS}/hello/queue`, { body: { job: 1 } });
    expect(e.status).toBe(201);
    expect(((await e.json()) as { id: string }).id).toMatch(/^msg_/);
    expect((await w.admin.call("POST", `${APPS}/hello/queue`, {})).status).toBe(422);
    expect(await (await w.admin.call("GET", `${APPS}/hello/queue`)).json()).toMatchObject({ depth: 1, dlq: 0 });
    w.fake.deadLetter(svcOf(w, "hello"), { bad: true });
    const dlq = (await (await w.admin.call("GET", `${APPS}/hello/dlq`)).json()) as { items: { body: unknown }[] };
    expect(dlq.items[0]?.body).toEqual({ bad: true });
    expect(await (await w.admin.call("POST", `${APPS}/hello/dlq/redrive`)).json()).toEqual({ redriven: 1 });
    expect((await w.admin.call("DELETE", `${APPS}/hello/dlq`)).status).toBe(204);
    w.fake.failNext({ status: 429, code: "queue_full", retryAfter: 2 });
    const full = await w.admin.call("POST", `${APPS}/hello/queue`, { body: 1 });
    expect(full.status).toBe(429);
    expect((await errOf(full)).code).toBe("queue_full");
  });

  it("stats window, events page", async () => {
    const w = await world();
    await createApp(w.admin);
    const s = await w.admin.call("GET", `${APPS}/hello/stats`);
    expect(await s.json()).toMatchObject({ window: "5m", count: 3, requests: 3, errors: 1, p50_ms: 12, p95_ms: 40, p99_ms: 90, total: { p95_ms: 40 } });
    const day = await w.admin.call("GET", `${APPS}/hello/stats?window=24h`);
    expect(await day.json()).toMatchObject({ window: "24h", requests: 30 });
    expect((await w.admin.call("GET", `${APPS}/hello/stats?window=7d`)).status).toBe(422);
    const ev = (await (await w.admin.call("GET", `${APPS}/hello/events`)).json()) as { items: { kind: string }[]; next_cursor: unknown };
    expect(ev.items.map((e) => e.kind)).toContain("service.created");
    expect(ev).toHaveProperty("next_cursor");
  });
});

describe("logs SSE", () => {
  function parse(text: string) {
    return text.split("\n\n").filter(Boolean).map((b) => Object.fromEntries(b.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()])));
  }

  it("emits id:/event: log lines, ends with retry: before 25 s, resumes with Last-Event-ID", async () => {
    const w = await world();
    await createApp(w.admin);
    const svc = svcOf(w, "hello");
    w.fake.emitLog(svc, "one");
    w.fake.emitLog(svc, "two", { k: 1 }, "warn");
    const t0 = w.app.deps.now();
    const r = await w.admin.call("GET", `${APPS}/hello/logs`, undefined, { accept: "text/event-stream" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    expect(r.headers.get("x-accel-buffering")).toBe("no");
    const text = await r.text();
    const elapsed = w.app.deps.now() - t0;
    expect(elapsed).toBeLessThan(25_000);
    expect(elapsed).toBeGreaterThan(20_000);
    const ev = parse(text);
    const logs = ev.filter((e) => e.event === "log");
    expect(logs.map((e) => e.id)).toEqual(["1", "2"]);
    expect(JSON.parse(logs[1]?.data ?? "{}")).toMatchObject({ seq: 2, level: "warn", msg: "two", fields: { k: 1 }, version: null, truncated: false });
    expect(JSON.parse(logs[0]?.data ?? "{}")).not.toHaveProperty("service_id");
    expect(text).toContain(": ping");
    expect(text.trimEnd().endsWith("retry: 500")).toBe(true);
    const polls = w.fake.calls.filter((c) => c.path.endsWith("/logs")).length;
    expect(polls).toBeLessThanOrEqual(40);

    w.fake.emitLog(svc, "three");
    const r2 = await w.admin.call("GET", `${APPS}/hello/logs?level=warn`, undefined, { "last-event-id": "2" });
    const ev2 = parse(await r2.text()).filter((e) => e.event === "log");
    expect(ev2).toEqual([]); // "three" is info, filtered by level=warn
    const r3 = await w.admin.call("GET", `${APPS}/hello/logs?last_event_id=1`);
    expect(parse(await r3.text()).filter((e) => e.event === "log").map((e) => e.id)).toEqual(["2", "3"]);
  });

  it("errors before the stream: 422 bad level, 404 unknown app; app deleted mid-stream → event: error", async () => {
    const w = await world();
    await createApp(w.admin);
    expect((await w.admin.call("GET", `${APPS}/hello/logs?level=loud`)).status).toBe(422);
    expect((await w.admin.call("GET", `${APPS}/nope/logs`)).status).toBe(404);
    const svc = svcOf(w, "hello");
    let n = 0;
    const orig = w.fake.tenant.bind(w.fake);
    w.fake.tenant = async (k, r) => {
      if (r.path.endsWith("/logs") && ++n === 2) w.fake.services.delete(svc);
      return orig(k, r);
    };
    const text = await (await w.admin.call("GET", `${APPS}/hello/logs`)).text();
    expect(text).toContain("event: error");
    expect(text).toContain('"code":"not_found"');
    expect(text).not.toContain("retry:");
  });
});

describe("export", () => {
  function withExport(fake: FakeRtCtl, data: Uint8Array, honourRange: boolean): RtCtl {
    const b64 = (u: Uint8Array) => {
      let s = "";
      for (const x of u) s += String.fromCharCode(x);
      return btoa(s);
    };
    return {
      op: (r) => fake.op(r),
      tenant: async (k: string, r: CtlReq): Promise<CtlRes> => {
        if (!r.path.endsWith("/data/export")) return fake.tenant(k, r);
        const ct = { "content-type": "application/vnd.sqlite3" };
        const m = /bytes=(\d+)-(\d+)/.exec(r.headers?.range ?? "");
        if (!honourRange || !m) return { status: 200, headers: ct, body: b64(data), encoding: "base64" };
        const a = Number(m[1]);
        const e = Math.min(Number(m[2]), data.length - 1);
        return { status: 206, headers: { ...ct, "content-range": `bytes ${a}-${e}/${data.length}` }, body: b64(data.subarray(a, e + 1)), encoding: "base64" };
      },
    };
  }
  const blob = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31) % 251);

  it("streams the snapshot over Range hops", async () => {
    const fake = new FakeRtCtl();
    const data = blob(500_000);
    const w = await world({ fake, rtctl: withExport(fake, data, true) });
    await createApp(w.admin);
    const r = await w.admin.call("GET", `${APPS}/hello/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/vnd.sqlite3");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="hello.sqlite"');
    expect(Buffer.from(await r.arrayBuffer()).equals(Buffer.from(data))).toBe(true);
  });

  it("small snapshot without Range support is fine; over the cap → 413 export_too_large", async () => {
    const fake = new FakeRtCtl();
    const small = blob(1000);
    let w = await world({ fake, rtctl: withExport(fake, small, false) });
    await createApp(w.admin);
    expect(new Uint8Array(await (await w.admin.call("GET", `${APPS}/hello/export`)).arrayBuffer())).toEqual(small);
    const fake2 = new FakeRtCtl();
    w = await world({ fake: fake2, rtctl: withExport(fake2, blob(300_000), false) });
    await createApp(w.admin);
    const r = await w.admin.call("GET", `${APPS}/hello/export`);
    expect(r.status).toBe(413);
    expect(await errOf(r)).toEqual({ code: "export_too_large", message: expect.any(String), details: { cli: "21ci data export" } });
  });
});

describe("pure helpers", () => {
  it("isCidr", () => {
    for (const ok of ["10.0.0.0/8", "0.0.0.0/0", "::/0", "2001:db8::/32", "fe80::1/128"]) expect(isCidr(ok), ok).toBe(true);
    for (const bad of ["10.0.0.0", "10.0.0.256/8", "10.0.0.0/33", "1::2::3/64", "x/1", "::/129"]) expect(isCidr(bad), bad).toBe(false);
  });
  it("checkPath + unpack", () => {
    for (const ok of ["main.ts", "lib/a.ts"]) expect(checkPath(ok)).toBe(true);
    for (const bad of ["", "/abs", "../x", "a/../b", "./a", "a\\b", "a//b"]) expect(checkPath(bad), bad).toBe(false);
    expect(unpack("const a = 1", "application/typescript")).toMatchObject({ kind: "ts", entry: "main.ts" });
    expect(unpack("x", "text/javascript")).toMatchObject({ kind: "js", entry: "main.js" });
    expect(unpack('{"entry":"a.ts","files":{"a.ts":"1"}}', "")).toMatchObject({ kind: "bundle", entry: "a.ts" });
    expect(unpack("AGFzbQ==", "application/wasm", true)).toMatchObject({ kind: "wasm", read_only: true, files: {} });
    // The runtime serves stored source as application/octet-stream; the SDK hands it over base64.
    const b64 = (t: string) => Buffer.from(t, "latin1").toString("base64");
    expect(unpack(b64("export default {}"), "application/octet-stream", true)).toMatchObject({ kind: "ts", entry: "main.ts", read_only: false });
    expect(unpack(b64('{"entry":"a.ts","files":{"a.ts":"1"}}'), "application/octet-stream", true)).toMatchObject({ kind: "bundle", entry: "a.ts" });
    expect(unpack(b64("PK\x03\x04rest"), "application/octet-stream", true)).toMatchObject({ kind: "bundle", read_only: true });
    expect(unpack(b64("\x00asm\x01"), "application/octet-stream", true)).toMatchObject({ kind: "wasm", read_only: true });
    expect(() => unpack('{"entry":"../a","files":{"../a":"1"}}', "application/json")).toThrow();
  });
});

describe("statsView", () => {
  it("zero-fills when the runtime body has no counts", async () => {
    const { statsView } = await import("../../src/routes/apps.ts");
    expect(statsView(null, "1h")).toEqual({ window: "1h", requests: 0, errors: 0, error_rate: 0, p50_ms: 0, p95_ms: 0, p99_ms: 0 });
  });
});
