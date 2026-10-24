import { describe, expect, it } from "vitest";
import { clearCookie, getCookie, oauthStateCookieName, sessionCookieName, setCookie } from "../../src/http/cookies.ts";

describe("cookies", () => {
  it("names: __Host- prefix in production, plain in insecure mode", () => {
    expect(sessionCookieName({ insecure: false })).toBe("__Host-rtw_session");
    expect(sessionCookieName({ insecure: true })).toBe("rtw_session");
    expect(oauthStateCookieName({ insecure: false })).toBe("__Host-rtw_oauth");
    expect(oauthStateCookieName({ insecure: true })).toBe("rtw_oauth");
  });

  it("setCookie in production has Secure, HttpOnly, SameSite=Lax, Path=/, no Domain", () => {
    const h = setCookie("__Host-rtw_session", "v1", { insecure: false, maxAgeSeconds: 60 });
    expect(h).toBe("__Host-rtw_session=v1; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax");
    expect(h).not.toMatch(/Domain=/i);
  });

  it("setCookie in insecure mode drops Secure only", () => {
    const h = setCookie("rtw_session", "v1", { insecure: true, maxAgeSeconds: 60 });
    expect(h).toBe("rtw_session=v1; Max-Age=60; Path=/; HttpOnly; SameSite=Lax");
  });

  it("clearCookie expires immediately with the same attributes", () => {
    const h = clearCookie("__Host-rtw_session", { insecure: false });
    expect(h).toContain("__Host-rtw_session=;");
    expect(h).toContain("Max-Age=0");
    expect(h).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(h).toContain("Secure");
    expect(h).toContain("HttpOnly");
  });

  it("getCookie reads a named cookie from the Cookie header", () => {
    const req = new Request("http://localhost/", {
      headers: { cookie: "a=1; __Host-rtw_session=abc%20def; b=2" },
    });
    expect(getCookie(req, "__Host-rtw_session")).toBe("abc def");
    expect(getCookie(req, "missing")).toBeUndefined();
  });

  it("getCookie ignores malformed percent-encoding instead of throwing", () => {
    const req = new Request("http://localhost/", { headers: { cookie: "x=%E0%A4%A" } });
    expect(getCookie(req, "x")).toBe("%E0%A4%A");
  });
});
