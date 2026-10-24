import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const KEY_B64 = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const base = {
  RTWEB_ORIGIN: "https://console.example.com",
  RTWEB_SEAL_KEY: KEY_B64,
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
