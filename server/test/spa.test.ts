import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TEST_ORIGIN, testApp } from "./harness.ts";
import { memoryBlobs, type AssetManifest } from "../src/spa.ts";

const INDEX = `<!doctype html><html><head><script src="/theme-init.js"></script>
<script type="module" crossorigin src="/assets/index-A.js"></script><link rel="stylesheet" href="/assets/index-B.css"></head><body></body></html>`;

function manifest(): AssetManifest {
  return {
    "/index.html": { type: "text/html; charset=utf-8", etag: '"i1"', size: INDEX.length, enc: "text", load: async () => ({ default: INDEX }) },
    "/assets/a.js": { type: "text/javascript; charset=utf-8", etag: '"a1"', size: 9, enc: "text", load: async () => ({ default: "export {}" }) },
    "/favicon.png": { type: "image/png", etag: '"p1"', size: 3, enc: "b64", load: async () => ({ default: "AQID" }) },
    "/assets/big.js": { type: "text/javascript; charset=utf-8", etag: '"b1"', size: 6, blob: { parts: 2 } },
  };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hdrs = (body: string, token = "tok"): Record<string, string> => ({
  "x-rtweb-asset-token": token,
  "x-rtweb-part-sha256": sha(body),
  "x-rt-client-ip": "127.0.0.1",
});

function app(token = "tok") {
  const blobs = memoryBlobs();
  const a = testApp({ spa: { assets: manifest(), blobs, assetToken: () => token } });
  return { a, blobs };
}

describe("spa", () => {
  it("serves index.html for client routes", async () => {
    const res = await app().a.call("GET", "/orgs/x");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain('src="/assets/index-A.js"');
  });

  it("serves / as index.html", async () => {
    expect((await app().a.call("GET", "/")).status).toBe(200);
  });

  it("serves /assets/* as immutable", async () => {
    const res = await app().a.call("GET", "/assets/a.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("etag")).toBe('"a1"');
    expect(await res.text()).toBe("export {}");
  });

  it("decodes base64 assets", async () => {
    const res = await app().a.call("GET", "/favicon.png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("answers 304 for a matching If-None-Match", async () => {
    const res = await app().a.call("GET", "/assets/a.js", { headers: { "if-none-match": '"a1"' } });
    expect(res.status).toBe(304);
  });

  it("does not fall back for missing /assets/* files", async () => {
    expect((await app().a.call("GET", "/assets/missing.js")).status).toBe(404);
  });

  it("never falls back for /api paths", async () => {
    const res = await app().a.call("GET", "/api/x");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "not found" } });
  });

  it("does not fall back for non-GET methods", async () => {
    expect((await app().a.call("POST", "/orgs/x", { headers: { origin: TEST_ORIGIN } })).status).toBe(404);
  });

  it("honours x-rt-base-path in index.html", async () => {
    const res = await app().a.call("GET", "/orgs/x", { headers: { "x-rt-base-path": "/s/rtweb" } });
    const html = await res.text();
    expect(html).toContain('<base href="/s/rtweb/">');
    expect(html).toContain('src="/s/rtweb/assets/index-A.js"');
    expect(html).toContain('href="/s/rtweb/assets/index-B.css"');
    expect(html).toContain('src="/s/rtweb/theme-init.js"');
  });

  it("ignores an unsafe x-rt-base-path", async () => {
    const res = await app().a.call("GET", "/", { headers: { "x-rt-base-path": '/x"><script>' } });
    const html = await res.text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain('<base href="/">');
  });

  it("uploads and streams blob-backed assets", async () => {
    const { a } = app();
    const put = (part: number, body: string, token = "tok") =>
      a.fetch(new Request(`http://localhost/api/internal/assets/b1/${part}`, { method: "PUT", body, headers: hdrs(body, token) }));
    expect((await put(0, "abc", "bad")).status).toBe(403);
    expect((await put(0, "abc")).status).toBe(204);
    expect((await a.call("GET", "/assets/big.js")).status).toBe(503);
    expect((await put(1, "def")).status).toBe(204);
    const res = await a.call("GET", "/assets/big.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toBe("abcdef");
  });

  it("refuses asset uploads when no token is configured", async () => {
    const { a } = app("");
    const res = await a.fetch(new Request("http://localhost/api/internal/assets/b1/0", { method: "PUT", body: "x", headers: hdrs("x", "") }));
    expect(res.status).toBe(403);
  });

  it("rejects uploads for unknown assets or parts", async () => {
    const { a } = app();
    const put = (p: string) => a.fetch(new Request(`http://localhost/api/internal/assets/${p}`, { method: "PUT", body: "x", headers: hdrs("x") }));
    expect((await put("zz/0")).status).toBe(404);
    expect((await put("b1/2")).status).toBe(404);
  });

  it("rejects a part whose x-rtweb-part-sha256 is missing or does not match", async () => {
    const { a, blobs } = app();
    const put = (headers: Record<string, string>) =>
      a.fetch(new Request("http://localhost/api/internal/assets/b1/0", { method: "PUT", body: "abc", headers }));
    const noSum = hdrs("abc");
    delete noSum["x-rtweb-part-sha256"];
    for (const h of [noSum, hdrs("abd"), { ...hdrs("abc"), "x-rtweb-part-sha256": "zz" }]) {
      const res = await put(h);
      expect(res.status).toBe(422);
    }
    expect(await blobs.get("spa/b1/0")).toBeNull();
    expect((await put(hdrs("abc"))).status).toBe(204);
  });

  it("checks parts against manifest hashes when present", async () => {
    const blobs = memoryBlobs();
    const m = manifest();
    m["/assets/big.js"] = { type: "text/javascript; charset=utf-8", etag: '"b1"', size: 6, blob: { parts: 2, sha256: [sha("abc"), sha("def")] } };
    const a = testApp({ spa: { assets: m, blobs, assetToken: () => "tok" } });
    const put = (part: number, body: string) =>
      a.fetch(new Request(`http://localhost/api/internal/assets/b1/${part}`, { method: "PUT", body, headers: hdrs(body) }));
    expect((await put(0, "evil")).status).toBe(422);
    expect((await put(0, "abc")).status).toBe(204);
  });

  it("refuses internal asset uploads from a non-loopback client", async () => {
    const { a } = app();
    for (const ip of ["203.0.113.9", "10.0.0.1", "::ffff:198.51.100.1", ""]) {
      const h: Record<string, string> = hdrs("abc");
      if (ip) h["x-rt-client-ip"] = ip;
      else delete h["x-rt-client-ip"];
      const res = await a.fetch(new Request("http://localhost/api/internal/assets/b1/0", { method: "PUT", body: "abc", headers: h }));
      expect(res.status).toBe(404);
    }
    for (const ip of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) {
      const res = await a.fetch(new Request("http://localhost/api/internal/assets/b1/0", { method: "PUT", body: "abc", headers: { ...hdrs("abc"), "x-rt-client-ip": ip } }));
      expect(res.status).toBe(204);
    }
  });

  it("is absent when no manifest is configured", async () => {
    expect((await testApp().call("GET", "/orgs/x")).status).toBe(404);
  });
});
