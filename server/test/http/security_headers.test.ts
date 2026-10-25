import { describe, expect, it } from "vitest";
import { testApp, testConfig } from "../harness.ts";
import type { AssetManifest } from "../../src/spa.ts";
import { CSP, cspFor } from "../../src/http/security.ts";

const INDEX = "<!doctype html><html><head></head><body></body></html>";
const assets: AssetManifest = {
  "/index.html": { type: "text/html; charset=utf-8", etag: '"i1"', size: INDEX.length, enc: "text", load: async () => ({ default: INDEX }) },
  "/assets/a.js": { type: "text/javascript; charset=utf-8", etag: '"a1"', size: 9, enc: "text", load: async () => ({ default: "export {}" }) },
};

function expectBase(res: Response) {
  expect(res.headers.get("content-security-policy")).toBe(CSP);
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  expect(res.headers.get("permissions-policy")).toMatch(/camera=\(\)/);
}

describe("security headers (M4)", () => {
  it("CSP forbids framing, inline script and foreign origins", () => {
    for (const d of ["default-src 'self'", "script-src 'self'", "img-src 'self' data:", "connect-src 'self'", "worker-src 'self'",
      "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"]) expect(CSP).toContain(d);
    expect(CSP).not.toMatch(/script-src[^;]*unsafe/);
    expect(CSP).toContain("frame-src 'none'");
  });

  it("frames only a foreign runtime app origin", () => {
    expect(cspFor("https://console.example.com", "https://apps.example.com")).toContain("frame-src https://apps.example.com");
    expect(cspFor("https://console.example.com", "https://console.example.com")).toContain("frame-src 'none'");
  });

  it("sends the runtime app origin as frame-src", async () => {
    const app = testApp({ config: testConfig({ runtimePublicUrl: "https://apps.example.com/base" }) });
    const res = await app.call("GET", "/api/health");
    expect(res.headers.get("content-security-policy")).toMatch(/frame-src https:\/\/apps\.example\.com(;|$)/);
  });

  it("are set on SPA pages, assets, JSON, errors and 304s, with HSTS on https", async () => {
    const app = testApp({ spa: { assets } });
    for (const [path, h] of [["/orgs/x", {}], ["/assets/a.js", {}], ["/assets/a.js", { "if-none-match": '"a1"' }], ["/api/health", {}], ["/api/nope", {}]] as const) {
      const res = await app.call("GET", path, { headers: h });
      expectBase(res);
      expect(res.headers.get("strict-transport-security"), path).toBe("max-age=31536000; includeSubDomains");
    }
  });

  it("omit HSTS on an http origin", async () => {
    const app = testApp({ config: testConfig({ origin: "http://localhost:8080", insecureCookies: true }) });
    const res = await app.call("GET", "/api/health");
    expectBase(res);
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });
});
