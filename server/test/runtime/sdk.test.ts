/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { beforeEach, describe, expect, it, vi } from "vitest";

// sdk/rtctl/mod.ts runs in the runtime; stub its std modules for Node.
const kvStore = new Map<string, unknown>();
const fetched: { binding: string; req: Request }[] = [];
let respond: (b: string, r: Request) => Response = () => new Response("{}", { headers: { "content-type": "application/json" } });
let defined: { methods: Record<string, (a: unknown, ctx: unknown) => Promise<unknown>> };

vi.mock("std:sdk/server", () => ({ defineSdk: (d: typeof defined) => ((defined = d), d) }));
vi.mock("std:platform", () => ({
  platform: { fetch: async (b: string, r: Request) => (fetched.push({ binding: b, req: r }), respond(b, r)) },
}));
vi.mock("std:kv", () => ({
  kv: {
    get: async (k: string) => kvStore.get(k) ?? null,
    set: async (k: string, v: unknown) => void kvStore.set(k, v),
    delete: async (k: string) => kvStore.delete(k),
  },
}));

const TEN = "ten_rtweb";
(globalThis as { Deno?: unknown }).Deno = { env: { get: (n: string) => (n === "RTWEB_TENANT_ID" ? TEN : undefined) } };
const mod = await import("../../sdk/rtctl/mod.ts");
const ctx = (tenant = TEN, slug: string | null = "rtweb") => ({ caller: { tenant, project: null, environment: null, service: { id: "svc_1", slug } } });
const m = () => defined.methods;

beforeEach(() => {
  kvStore.clear();
  fetched.length = 0;
  respond = () => new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
});

describe("rtctl SDK", () => {
  it("refuses callers other than tenant runtime-web service rtweb", async () => {
    await expect(m().op!({ method: "GET", path: "/v1/version" }, ctx("ten_other"))).rejects.toMatchObject({ code: "forbidden" });
    await expect(m().op!({ method: "GET", path: "/v1/version" }, ctx(TEN, "other"))).rejects.toMatchObject({ code: "forbidden" });
    await expect(m().put!({ id: "a", index: 0, data: "x" }, ctx("ten_other"))).rejects.toMatchObject({ code: "forbidden" });
    expect(() => mod.checkCaller(ctx().caller, "__RTWEB_TENANT_ID__")).toThrow();
    expect(fetched).toEqual([]);
  });

  it("path allow-list per binding", () => {
    const yes: [string, string][] = [
      ["op", "/v1/tenants"], ["op", "/v1/tenants/ten_1/keys/key_1"], ["op", "/v1/node/status"], ["op", "/v1/version"],
      ["op", "/v1/services/svc_1/hosts/a.example.com"], ["tenant", "/v1/services/svc_1/schedules/once"],
      ["tenant", "/v1/keys"], ["tenant", "/v1/tenants/ten_1/usage"], ["tenant", "/v1/projects/web/environments"],
    ];
    const no: [string, string][] = [
      ["op", "/v1/services"], ["op", "/v1/sdks"], ["op", "/v1/sdk-grants"], ["tenant", "/v1/tenants"], ["tenant", "/v1/node/status"],
      ["tenant", "/v1/services/../tenants"], ["tenant", "/v1/services/%2e%2e/tenants"], ["tenant", "/v1/services/%252e"],
      ["tenant", "/v1//services"], ["tenant", "/v1/services/a\\b"], ["tenant", "/v1/services?x=1"], ["op", "/v1/tenants/"],
      ["tenant", "/v1/services/a%0a"],
    ];
    for (const [s, p] of yes) expect(mod.pathAllowed(s as "op", p), p).toBe(true);
    for (const [s, p] of no) expect(mod.pathAllowed(s as "op", p), p).toBe(false);
  });

  it("op uses rtctl-op; tenant uses rtctl-tenant with x-rtweb-key; only safe headers forwarded", async () => {
    const r1 = (await m().op!({ method: "GET", path: "/v1/node/status", headers: { authorization: "x", "x-rt-tenant": "t", accept: "application/json" } }, ctx())) as { status: number; body: string };
    expect([r1.status, r1.body]).toEqual([200, '{"ok":true}']);
    expect(fetched[0]!.binding).toBe("rtctl-op");
    expect(fetched[0]!.req.headers.get("authorization")).toBeNull();
    expect(fetched[0]!.req.headers.get("x-rt-tenant")).toBeNull();
    expect(fetched[0]!.req.headers.get("accept")).toBe("application/json");
    await m().tenant!({ method: "PATCH", path: "/v1/services/svc_1", query: { a: "1" }, headers: { "if-match": '"2"' }, body: '{"name":"x"}', contentType: "application/json", key: "rtk_key_abcdef0123" }, ctx());
    const r = fetched[1]!.req;
    expect([fetched[1]!.binding, r.method, new URL(r.url).pathname + new URL(r.url).search]).toEqual(["rtctl-tenant", "PATCH", "/v1/services/svc_1?a=1"]);
    expect([r.headers.get("x-rtweb-key"), r.headers.get("if-match"), r.headers.get("content-type")]).toEqual(["rtk_key_abcdef0123", '"2"', "application/json"]);
    expect(await r.text()).toBe('{"name":"x"}');
  });

  it("validates method and tenant key", async () => {
    await expect(m().op!({ method: "TRACE", path: "/v1/version" }, ctx())).rejects.toMatchObject({ code: "validation_failed" });
    await expect(m().tenant!({ method: "GET", path: "/v1/me" }, ctx())).rejects.toMatchObject({ code: "validation_failed" });
    await expect(m().op!({ method: "GET", path: "/v1/sdks" }, ctx())).rejects.toMatchObject({ code: "path_denied" });
  });

  it("binding refusals resolve as responses carrying x-rt-reason", async () => {
    respond = () => new Response("binding_denied", { status: 403, headers: { "content-type": "text/plain", "x-rt-reason": "binding_denied" } });
    const r = (await m().op!({ method: "GET", path: "/v1/version" }, ctx())) as { status: number; headers: Record<string, string> };
    expect([r.status, r.headers["x-rt-reason"]]).toEqual([403, "binding_denied"]);
  });

  it("chunks request bodies (put + bodyRef) and responses over the limit (chunked + get)", async () => {
    const big = "y".repeat(mod.CHUNK * 2 + 10);
    for (let i = 0; i < 3; i++) await m().put!({ id: "abc", index: i, data: big.slice(i * mod.CHUNK, (i + 1) * mod.CHUNK) }, ctx());
    await expect(m().put!({ id: "abc", index: 0, data: "z".repeat(mod.CHUNK + 1) }, ctx())).rejects.toMatchObject({ code: "validation_failed" });
    await expect(m().put!({ id: "../x", index: 0, data: "" }, ctx())).rejects.toMatchObject({ code: "validation_failed" });
    respond = () => new Response(big, { headers: { "content-type": "application/typescript" } });
    const r = (await m().tenant!({ method: "POST", path: "/v1/services/s/versions", bodyRef: { id: "abc", parts: 3 }, contentType: "application/typescript", key: "rtk_key_abcdef0123" }, ctx())) as { chunked: { id: string; parts: number }; body?: string };
    expect(await fetched[0]!.req.text()).toBe(big);
    expect(r.body).toBeUndefined();
    expect(r.chunked.parts).toBe(3);
    const parts: string[] = [];
    for (let i = 0; i < 3; i++) parts.push(((await m().get!({ id: r.chunked.id, index: i }, ctx())) as { data: string }).data);
    expect(parts.join("")).toBe(big);
    // chunks are keyed by caller tenant and single-use
    await expect(m().get!({ id: r.chunked.id, index: 0 }, ctx())).rejects.toMatchObject({ code: "chunk_missing" });
    await expect(m().tenant!({ method: "POST", path: "/v1/services/s/versions", bodyRef: { id: "abc", parts: 3 }, key: "rtk_key_abcdef0123" }, ctx())).rejects.toMatchObject({ code: "chunk_missing" });
  });

  it("binary responses are base64", async () => {
    respond = () => new Response(new Uint8Array([0, 255, 1]), { headers: { "content-type": "application/vnd.sqlite3" } });
    const r = (await m().tenant!({ method: "GET", path: "/v1/services/s/data/export", key: "rtk_key_abcdef0123" }, ctx())) as { body: string; encoding: string };
    expect([r.body, r.encoding]).toEqual(["AP8B", "base64"]);
  });
});
