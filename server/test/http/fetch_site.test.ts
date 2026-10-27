// Review item 13: Sec-Fetch-Site on unsafe methods. Apps live on a sibling host of the console
// (same site), so a matching Origin alone is not enough when the browser says the request is
// same-site or cross-site.
import { describe, expect, it } from "vitest";
import { APPS, createApp, errOf, world } from "../apps/helpers.ts";

describe("originCheck and Sec-Fetch-Site", () => {
  it("refuses unsafe requests that are not same-origin or user-initiated", async () => {
    const w = await world();
    await createApp(w.admin);
    for (const site of ["same-site", "cross-site", "bogus"]) {
      const r = await w.admin.call("PUT", `${APPS}/hello/env`, { env: { A: "1" } }, { "sec-fetch-site": site });
      expect(r.status, site).toBe(403);
      expect((await errOf(r)).code).toBe("origin_invalid");
    }
    for (const site of ["same-origin", "none", "Same-Origin"]) {
      expect((await w.admin.call("PUT", `${APPS}/hello/env`, { env: { A: "1" } }, { "sec-fetch-site": site })).status, site).toBe(200);
    }
    // Clients that send no Sec-Fetch-Site still pass on Origin alone.
    expect((await w.admin.call("PUT", `${APPS}/hello/env`, { env: { A: "2" } })).status).toBe(200);
  });

  it("does not affect safe methods or public routes' Origin rule", async () => {
    const w = await world();
    await createApp(w.admin);
    expect((await w.admin.call("GET", `${APPS}/hello`, undefined, { "sec-fetch-site": "cross-site" })).status).toBe(200);
    const login = await w.app.call("POST", "/api/auth/login", { body: { email: "a@b.c", password: "x" }, headers: { origin: "https://console.test", "sec-fetch-site": "same-site" } });
    expect(login.status).toBe(403);
  });
});
