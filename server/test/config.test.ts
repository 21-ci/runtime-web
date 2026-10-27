import { describe, expect, it } from "vitest";
import { loadConfig, registrableDomain } from "../src/config.ts";

const KEY_B64 = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const base = {
  RTWEB_ORIGIN: "https://console.example.com",
  RTWEB_SEAL_KEY: KEY_B64,
  RTWEB_APPS_URL: "https://apps.example.net",
};
const env = (vars: Record<string, string | undefined>) => (name: string) => vars[name];

describe("loadConfig", () => {
  it("accepts a minimal production env and normalises origin", () => {
    const c = loadConfig(env({ ...base, RTWEB_ORIGIN: "https://Console.example.com/" }));
    expect(c.origin).toBe("https://console.example.com");
    expect(c.insecureCookies).toBe(false);
    expect(c.sealKey.length).toBe(32);
    expect(c.setupToken).toBeUndefined();
  });

  it("reads RTWEB_SETUP_TOKEN and RTWEB_INSECURE_COOKIES", () => {
    const c = loadConfig(
      env({ ...base, RTWEB_ORIGIN: "http://localhost:5173", RTWEB_INSECURE_COOKIES: "1", RTWEB_SETUP_TOKEN: "abc" }),
    );
    expect(c.insecureCookies).toBe(true);
    expect(c.setupToken).toBe("abc");
  });

  it.each([
    ["missing origin", { RTWEB_SEAL_KEY: KEY_B64 }, /RTWEB_ORIGIN/],
    ["origin not absolute", { ...base, RTWEB_ORIGIN: "console" }, /RTWEB_ORIGIN/],
    ["origin with path", { ...base, RTWEB_ORIGIN: "https://x.example.com/app" }, /RTWEB_ORIGIN/],
    ["plain http without insecure flag", { ...base, RTWEB_ORIGIN: "http://console.example.com" }, /https/],
    ["missing seal key", { RTWEB_ORIGIN: base.RTWEB_ORIGIN }, /RTWEB_SEAL_KEY/],
    ["seal key wrong length", { ...base, RTWEB_SEAL_KEY: btoa("short") }, /32 bytes/],
    ["seal key not base64", { ...base, RTWEB_SEAL_KEY: "!!!" }, /RTWEB_SEAL_KEY/],
  ])("fails closed on %s", (_name, vars, msg) => {
    expect(() => loadConfig(env(vars))).toThrow(msg);
  });
});

describe("same-site warning", () => {
  it("warns when console and Apps share a registrable domain", () => {
    const notes: string[] = [];
    loadConfig(env({ ...base, RTWEB_APPS_URL: "https://apps.example.com" }), (m) => notes.push(m));
    expect(notes.join()).toMatch(/share the site example\.com/);
    const none: string[] = [];
    loadConfig(env(base), (m) => none.push(m));
    expect(none).toEqual([]);
  });

  it.each([
    ["console.example.com", "example.com"], ["a.b.example.co.uk", "example.co.uk"], ["localhost", ""], ["127.0.0.1", ""],
  ])("registrableDomain(%s) = %s", (h, want) => {
    expect(registrableDomain(h)).toBe(want);
  });
});

describe("apps URL and default plan", () => {
  it("accepts the deprecated RTWEB_RUNTIME_PUBLIC_URL with a warning", () => {
    const notes: string[] = [];
    const c = loadConfig(env({ ...base, RTWEB_APPS_URL: undefined, RTWEB_RUNTIME_PUBLIC_URL: "https://apps.example.org" }), (m) => notes.push(m));
    expect(c.runtimePublicUrl).toBe("https://apps.example.org");
    expect(notes.join()).toMatch(/deprecated/);
  });

  it("defaults: plan free", () => {
    expect(loadConfig(env(base)).defaultPlan).toBe("free");
  });

  it("fails closed without an apps origin, unless insecure (development)", () => {
    expect(() => loadConfig(env({ ...base, RTWEB_APPS_URL: undefined }))).toThrow(/RTWEB_APPS_URL: required/);
    const dev = loadConfig(env({ ...base, RTWEB_ORIGIN: "http://localhost:8080", RTWEB_INSECURE_COOKIES: "1", RTWEB_APPS_URL: undefined }));
    expect(dev.runtimePublicUrl).toBe("");
  });

  it("reads and normalises RTWEB_APPS_URL and RTWEB_DEFAULT_PLAN", () => {
    const c = loadConfig(env({ ...base, RTWEB_APPS_URL: "https://rt.example.com/", RTWEB_DEFAULT_PLAN: "pro" }));
    expect(c.runtimePublicUrl).toBe("https://rt.example.com");
    expect(c.defaultPlan).toBe("pro");
  });

  it.each([
    [{ RTWEB_APPS_URL: "rt.example.com" }, /RTWEB_APPS_URL/],
    [{ RTWEB_APPS_URL: "ftp://rt.example.com" }, /RTWEB_APPS_URL/],
    [{ RTWEB_APPS_URL: "https://console.example.com" }, /must not share the console origin/],
    [{ RTWEB_APPS_URL: "https://CONSOLE.example.com:443/apps/" }, /must not share the console origin/],
    [{ RTWEB_DEFAULT_PLAN: "Bad Plan!" }, /RTWEB_DEFAULT_PLAN/],
  ])("rejects %o", (over, msg) => {
    expect(() => loadConfig(env({ ...base, ...over }))).toThrow(msg);
  });
});
