import { describe, expect, it } from "vitest";
import { appFrameSources } from "../../src/app.ts";
import { appUrl } from "../../src/apps/service.ts";
import { loadConfig } from "../../src/config.ts";

const KEY_B64 = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const env = (vars: Record<string, string | undefined>) => (name: string) => vars[name];
const base = { RTWEB_ORIGIN: "https://console.example.com", RTWEB_SEAL_KEY: KEY_B64 };

describe("appUrl", () => {
  it("puts every App on its own subdomain of the apps origin", () => {
    expect(appUrl("https://apps.example.com", "hello")).toBe("https://hello.apps.example.com/");
    expect(appUrl("https://apps.example.com:8443", "hello")).toBe("https://hello.apps.example.com:8443/");
    expect(appUrl("http://apps.localhost:8080", "x-1")).toBe("http://x-1.apps.localhost:8080/");
  });

  it("is relative without an apps origin (development)", () => {
    expect(appUrl("", "hello")).toBe("/s/hello/");
  });
});

describe("appFrameSources", () => {
  it("allows the App subdomains only", () => {
    expect(appFrameSources("")).toBeUndefined();
    expect(appFrameSources("https://apps.example.com")).toBe("https://*.apps.example.com");
  });
});

describe("RTWEB_RUNTIME_PUBLIC_URL", () => {
  it("must be an origin", () => {
    expect(() => loadConfig(env({ ...base, RTWEB_RUNTIME_PUBLIC_URL: "https://apps.example.com/x" }))).toThrow(/origin/);
  });

  it("refuses a console host under the apps host", () => {
    expect(() => loadConfig(env({ ...base, RTWEB_RUNTIME_PUBLIC_URL: "https://example.com" }))).toThrow(/subdomain/);
  });
});
