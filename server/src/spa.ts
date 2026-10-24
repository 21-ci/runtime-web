import type { Deps } from "./app.ts";
import { sha256Hex } from "./crypto/hash.ts";
import { AppError } from "./http/errors.ts";
import { loopbackOnly } from "./http/loopback.ts";
import type { RequestContext, Router } from "./http/router.ts";

// Serves the React console (web/dist) embedded by scripts/gen-assets.mjs.
// - /assets/* (hashed names): `immutable`, never the SPA fallback.
// - other known files: `no-cache` + ETag. Unknown non-/api GET paths: index.html.
// - index.html honours x-rt-base-path (path routes /s/<slug>, D11): <base href> plus
//   rewritten root-relative src/href attributes.
// - files too large for the bundle (>1 MB) live in std:blob in parts, uploaded by
//   scripts/install.mjs through PUT /api/internal/assets/{id}/{part} with the
//   RTWEB_ASSET_TOKEN secret.

export interface InlineAsset {
  type: string;
  etag: string;
  size: number;
  enc: "text" | "b64";
  load: () => Promise<{ default: string }>;
}
export interface BlobAsset {
  type: string;
  etag: string;
  size: number;
  /** sha256 (hex) per part, when the generator recorded them; uploads must match. */
  blob: { parts: number; sha256?: string[] };
}
export type Asset = InlineAsset | BlobAsset;
export type AssetManifest = Record<string, Asset>;

export interface BlobStore {
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
  head(key: string): Promise<{ size: number } | null>;
  put(key: string, body: ReadableStream<Uint8Array> | Uint8Array | string): Promise<void>;
}

export interface SpaDeps {
  assets: AssetManifest;
  blobs?: BlobStore;
  /** Returns the RTWEB_ASSET_TOKEN secret; empty or undefined disables uploads. */
  assetToken?: () => string | undefined;
}

const IMMUTABLE = "public, max-age=31536000, immutable";
const BASE_RE = /^(\/[A-Za-z0-9._~-]+)*$/;
const MAX_PART = 1_000_000;

const idOf = (etag: string) => etag.replace(/"/g, "");
const partKey = (id: string, n: number) => `spa/${id}/${n}`;

export function registerSpa(r: Router, deps: Deps): void {
  const spa = deps.spa;
  if (!spa) return;
  const byId = new Map<string, BlobAsset>();
  for (const a of Object.values(spa.assets)) if ("blob" in a) byId.set(idOf(a.etag), a);

  r.put("/api/internal/assets/:id/:part", loopbackOnly(async (ctx) => {
    const want = spa.assetToken?.() ?? "";
    const got = ctx.req.headers.get("x-rtweb-asset-token") ?? "";
    if (!want || !safeEqual(want, got)) throw new AppError(403, "forbidden", "forbidden");
    const asset = byId.get(ctx.params.id ?? "");
    const part = Number(ctx.params.part);
    if (!asset || !Number.isInteger(part) || part < 0 || part >= asset.blob.parts || !spa.blobs) {
      throw new AppError(404, "not_found", "not found");
    }
    const body = new Uint8Array(await ctx.req.arrayBuffer());
    if (body.length === 0 || body.length > MAX_PART) throw new AppError(413, "too_large", "part too large");
    const claimed = (ctx.req.headers.get("x-rtweb-part-sha256") ?? "").toLowerCase();
    const actual = await sha256Hex(body);
    const expected = asset.blob.sha256?.[part];
    if (!safeEqual(claimed, actual) || (expected !== undefined && !safeEqual(expected.toLowerCase(), actual))) {
      throw new AppError(422, "checksum_mismatch", "part checksum mismatch");
    }
    await spa.blobs.put(partKey(idOf(asset.etag), part), body);
    return new Response(null, { status: 204 });
  }));

  r.notFound(async (ctx) => {
    const method = ctx.req.method;
    if (method !== "GET" && method !== "HEAD") throw new AppError(404, "not_found", "not found");
    const path = ctx.url.pathname;
    let asset = spa.assets[path];
    if (!asset && path.startsWith("/assets/")) throw new AppError(404, "not_found", "not found");
    const isIndex = !asset || path === "/index.html";
    if (isIndex) asset = spa.assets["/index.html"];
    if (!asset) throw new AppError(404, "not_found", "not found");
    return isIndex ? serveIndex(ctx, asset) : serveFile(ctx, asset, path.startsWith("/assets/"), spa.blobs);
  });
}

async function serveIndex(ctx: RequestContext, asset: Asset): Promise<Response> {
  if (!("load" in asset)) throw new AppError(500, "internal", "index.html must be inline");
  const base = BASE_RE.test(ctx.basePath) ? ctx.basePath : "";
  const etag = `"${idOf(asset.etag)}${base ? "-" + base.replace(/\//g, "_") : ""}"`;
  const headers = { "content-type": asset.type, "cache-control": "no-cache", etag };
  if (notModified(ctx, etag)) return new Response(null, { status: 304, headers });
  const html = rewriteIndex((await asset.load()).default, base);
  return new Response(ctx.req.method === "HEAD" ? null : html, { headers });
}

/** Injects `<base href>` and prefixes root-relative src/href attributes with `base`. */
export function rewriteIndex(html: string, base: string): string {
  const out = base ? html.replace(/\b(src|href)="\/(?!\/)/g, `$1="${base}/`) : html;
  return out.replace(/<head>/i, `<head><base href="${base}/">`);
}

async function serveFile(ctx: RequestContext, asset: Asset, immutable: boolean, blobs?: BlobStore): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": asset.type,
    "cache-control": immutable ? IMMUTABLE : "no-cache",
    etag: asset.etag,
    "x-content-type-options": "nosniff",
  };
  if (notModified(ctx, asset.etag)) return new Response(null, { status: 304, headers });
  if ("load" in asset) {
    const raw = (await asset.load()).default;
    const body = asset.enc === "b64" ? b64decode(raw) : raw;
    return new Response(ctx.req.method === "HEAD" ? null : body, { headers });
  }
  const id = idOf(asset.etag);
  if (!blobs) throw new AppError(503, "asset_unavailable", "asset not uploaded");
  for (let i = 0; i < asset.blob.parts; i++) {
    if (!(await blobs.head(partKey(id, i)))) throw new AppError(503, "asset_unavailable", "asset not uploaded");
  }
  headers["content-length"] = String(asset.size);
  if (ctx.req.method === "HEAD") return new Response(null, { headers });
  let i = 0;
  let cur: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      for (;;) {
        if (!cur) {
          if (i >= asset.blob.parts) return ctrl.close();
          const obj = await blobs.get(partKey(id, i++));
          if (!obj) return ctrl.error(new Error("asset part missing"));
          cur = obj.body.getReader();
        }
        const { done, value } = await cur.read();
        if (done) {
          cur = null;
          continue;
        }
        ctrl.enqueue(value);
        return;
      }
    },
  });
  return new Response(stream, { headers });
}

function notModified(ctx: RequestContext, etag: string): boolean {
  const inm = ctx.req.headers.get("if-none-match");
  return !!inm && inm.split(",").some((t) => t.trim() === etag || t.trim() === "*");
}

function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) d |= (x[i] ?? 0) ^ (y[i % (y.length || 1)] ?? 0);
  return d === 0;
}

function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** In-memory BlobStore for tests. */
export function memoryBlobs(): BlobStore {
  const m = new Map<string, Uint8Array<ArrayBuffer>>();
  const bytes = async (b: ReadableStream<Uint8Array> | Uint8Array | string) =>
    typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b instanceof Uint8Array ? b : await new Response(b).arrayBuffer());
  return {
    get: async (k) => {
      const v = m.get(k);
      return v ? { body: new Response(v).body as ReadableStream<Uint8Array>, size: v.length } : null;
    },
    head: async (k) => (m.has(k) ? { size: (m.get(k) as Uint8Array<ArrayBuffer>).length } : null),
    put: async (k, b) => void m.set(k, await bytes(b)),
  };
}
