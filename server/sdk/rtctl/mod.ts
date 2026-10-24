// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- std module types for tsc; ignored by the runtime build
/// <reference path="./std.d.ts" />
// Operator SDK `rtctl` (design docs/contributing/architecture.md D3-D5).
// The one path from the rtweb service to the runtime control API:
//   op(req)      -> binding rtctl-op     (node injects the operator token)
//   tenant(req)  -> binding rtctl-tenant (relay maps x-rtweb-key -> Authorization)
//   put/get      -> body chunks for payloads over the 256 KiB SDK arg/result limit
// Only tenant runtime-web, service rtweb may call it. The install script
// replaces __RTWEB_TENANT_ID__ before `POST /v1/sdks` (or sets env RTWEB_TENANT_ID
// on the SDK service). Paths are checked here and again by the bindings.

import { defineSdk } from "std:sdk/server";
import { platform } from "std:platform";
import { kv } from "std:kv";

export const CHUNK = 150 * 1024;
const MAX_PARTS = 80; // 12 MB
const CHUNK_TTL = 120;
const BAKED_TENANT = "__RTWEB_TENANT_ID__";
// The unreplaced placeholder, spelled so install.mjs's replaceAll leaves it alone (else the guard compares
// the baked id with itself and refuses every caller).
const PLACEHOLDER = "__RTWEB_" + "TENANT_ID__";
const SERVICE_SLUG = "rtweb";

export interface Caller {
  tenant: string;
  project: string | null;
  environment: string | null;
  service: { id: string; slug: string | null };
  plan?: string;
}
interface Ctx {
  caller: Caller;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface WireReq {
  method: Method;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
  contentType?: string;
  bodyRef?: { id: string; parts: number };
  key?: string;
}
export interface WireRes {
  status: number;
  headers: Record<string, string>;
  body?: string;
  encoding?: "base64";
  chunked?: { id: string; parts: number };
}
export interface PutArgs {
  id: string;
  index: number;
  data: string;
}
export interface GetArgs {
  id: string;
  index: number;
}

class SdkFail extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

// ---- pure core (exported for tests) ----

export const OP_PATHS = [
  "/v1/tenants",
  "/v1/tenants/*",
  "/v1/plans",
  "/v1/plans/*",
  "/v1/node/*",
  "/v1/version",
  "/v1/hosts",
  "/v1/hosts/*",
  "/v1/services/*/hosts/*",
];
export const TENANT_PATHS = [
  "/v1/services",
  "/v1/services/*",
  "/v1/projects",
  "/v1/projects/*",
  "/v1/keys",
  "/v1/keys/*",
  "/v1/tenants/*/usage",
  "/v1/me",
  "/v1/limits",
];
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const FWD_HEADERS = new Set(["if-match", "if-none-match", "accept", "last-event-id"]);

function glob(p: string): RegExp {
  return new RegExp("^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
}
const OP_RE = OP_PATHS.map(glob);
const TENANT_RE = TENANT_PATHS.map(glob);

/** Strict path check: no dot segments, escapes other than %XX of safe bytes, empty segments or controls. */
export function pathAllowed(scope: "op" | "tenant", path: string): boolean {
  if (typeof path !== "string" || !path.startsWith("/v1/") || path.length > 1024) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\\?#\s\x00-\x1f\x7f]/.test(path) || path.includes("//")) return false;
  let dec: string;
  try {
    dec = decodeURIComponent(path);
  } catch {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  if (/%/.test(dec) || /[\\\x00-\x1f\x7f]/.test(dec)) return false;
  const segs = dec.split("/").slice(1);
  if (segs.some((s) => s === "" || s === "." || s === "..")) return false;
  return (scope === "op" ? OP_RE : TENANT_RE).some((re) => re.test(path));
}

export function checkCaller(caller: Caller | undefined, allowedTenant: string | undefined): Caller {
  if (!caller?.tenant || !allowedTenant || allowedTenant === PLACEHOLDER || caller.tenant !== allowedTenant) {
    throw new SdkFail("forbidden", "rtctl: caller not allowed");
  }
  if (caller.service?.slug !== SERVICE_SLUG) throw new SdkFail("forbidden", "rtctl: caller not allowed");
  return caller;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function checkRef(id: unknown, index: unknown, max = MAX_PARTS): void {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new SdkFail("validation_failed", "rtctl: bad chunk id");
  if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= max) {
    throw new SdkFail("validation_failed", "rtctl: bad chunk index");
  }
}

export interface KvLike {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<boolean>;
}
export interface CoreDeps {
  fetch(binding: string, req: Request): Promise<Response>;
  kv: KvLike;
  randomId: () => string;
}

function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
function isText(ct: string): boolean {
  return ct === "" || /^text\/|json|javascript|typescript|xml|event-stream|x-ndjson/.test(ct);
}

export function createCore(d: CoreDeps) {
  const inKey = (t: string, id: string, i: number) => `rtctl:in:${t}:${id}:${i}`;
  const outKey = (t: string, id: string, i: number) => `rtctl:out:${t}:${id}:${i}`;

  async function call(scope: "op" | "tenant", w: WireReq, caller: Caller): Promise<WireRes> {
    if (!w || typeof w !== "object") throw new SdkFail("validation_failed", "rtctl: request object required");
    if (!METHODS.has(w.method)) throw new SdkFail("validation_failed", "rtctl: method not allowed");
    if (!pathAllowed(scope, w.path)) throw new SdkFail("path_denied", `rtctl: path not allowed: ${String(w.path).slice(0, 200)}`);
    const headers = new Headers();
    for (const [k, v] of Object.entries(w.headers ?? {})) {
      if (FWD_HEADERS.has(k.toLowerCase()) && typeof v === "string") headers.set(k, v);
    }
    if (scope === "tenant") {
      if (typeof w.key !== "string" || !/^rtk_[A-Za-z0-9_-]{8,200}$/.test(w.key)) {
        throw new SdkFail("validation_failed", "rtctl: tenant key required");
      }
      headers.set("x-rtweb-key", w.key);
    }
    let body: string | undefined = w.body;
    if (w.bodyRef) {
      checkRef(w.bodyRef.id, 0);
      const n = w.bodyRef.parts;
      if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS) throw new SdkFail("validation_failed", "rtctl: bad parts");
      const parts: string[] = [];
      for (let i = 0; i < n; i++) {
        const p = await d.kv.get<string>(inKey(caller.tenant, w.bodyRef.id, i));
        if (typeof p !== "string") throw new SdkFail("chunk_missing", `rtctl: chunk ${i} missing`);
        parts.push(p);
        await d.kv.delete(inKey(caller.tenant, w.bodyRef.id, i));
      }
      body = parts.join("");
    }
    if (body !== undefined) headers.set("content-type", w.contentType || "application/json");
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(w.query ?? {})) if (typeof v === "string") qs.set(k, v);
    const q = qs.toString();
    const url = `http://rtctl${w.path}${q ? `?${q}` : ""}`;
    let bin: Uint8Array | undefined;
    if (body !== undefined && /;\s*base64$/.test(w.contentType ?? "")) {
      bin = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
      headers.set("content-type", (w.contentType ?? "").replace(/;\s*base64$/, ""));
    }
    const init: RequestInit = { method: w.method, headers };
    if (body !== undefined && w.method !== "GET") init.body = bin ? new Blob([bin as Uint8Array<ArrayBuffer>]) : body;
    const res = await d.fetch(scope === "op" ? "rtctl-op" : "rtctl-tenant", new Request(url, init));
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    const ct = (out["content-type"] ?? "").toLowerCase();
    let text: string;
    let encoding: "base64" | undefined;
    if (isText(ct)) text = await res.text();
    else {
      text = bytesToB64(new Uint8Array(await res.arrayBuffer()));
      encoding = "base64";
    }
    const r: WireRes = { status: res.status, headers: out };
    if (encoding) r.encoding = encoding;
    if (text.length <= CHUNK) {
      r.body = text;
      return r;
    }
    const parts = Math.ceil(text.length / CHUNK);
    if (parts > MAX_PARTS) throw new SdkFail("too_large", "rtctl: response too large");
    const id = d.randomId();
    for (let i = 0; i < parts; i++) {
      await d.kv.set(outKey(caller.tenant, id, i), text.slice(i * CHUNK, (i + 1) * CHUNK), { ttlSeconds: CHUNK_TTL });
    }
    r.chunked = { id, parts };
    return r;
  }

  return {
    call,
    async put(a: PutArgs, caller: Caller): Promise<{ ok: true }> {
      checkRef(a?.id, a?.index);
      if (typeof a.data !== "string" || a.data.length > CHUNK) throw new SdkFail("validation_failed", "rtctl: bad chunk");
      await d.kv.set(inKey(caller.tenant, a.id, a.index), a.data, { ttlSeconds: CHUNK_TTL });
      return { ok: true };
    },
    async get(a: GetArgs, caller: Caller): Promise<{ data: string }> {
      checkRef(a?.id, a?.index);
      const k = outKey(caller.tenant, a.id, a.index);
      const v = await d.kv.get<string>(k);
      if (typeof v !== "string") throw new SdkFail("chunk_missing", "rtctl: chunk missing or expired");
      await d.kv.delete(k);
      return { data: v };
    },
  };
}

// ---- SDK wiring ----

const core = createCore({
  fetch: (b, r) => platform.fetch(b, r),
  kv,
  randomId: () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => x.toString(16).padStart(2, "0")).join(""),
});
const allowed = () => Deno.env.get("RTWEB_TENANT_ID") || BAKED_TENANT;

export default defineSdk({
  methods: {
    async op(req: WireReq, ctx: Ctx): Promise<WireRes> {
      return core.call("op", req, checkCaller(ctx.caller, allowed()));
    },
    async tenant(req: WireReq, ctx: Ctx): Promise<WireRes> {
      return core.call("tenant", req, checkCaller(ctx.caller, allowed()));
    },
    async put(args: PutArgs, ctx: Ctx): Promise<{ ok: true }> {
      return core.put(args, checkCaller(ctx.caller, allowed()));
    },
    async get(args: GetArgs, ctx: Ctx): Promise<{ data: string }> {
      return core.get(args, checkCaller(ctx.caller, allowed()));
    },
  },
});
