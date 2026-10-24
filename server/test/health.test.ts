import { describe, expect, it } from "vitest";
import { testApp, TEST_ORIGIN } from "./harness.ts";

describe("health and router", () => {
  it("answers /healthz and /api/healthz", async () => {
    const app = testApp();
    for (const p of ["/healthz", "/api/healthz"]) {
      const res = await app.call("GET", p);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, db: true, version: "test" });
    }
  });

  it("returns the error envelope for unknown /api routes", async () => {
    const res = await testApp().call("GET", "/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "not found" } });
  });

  it("returns 405 for a known path with the wrong method", async () => {
    const res = await testApp().call("POST", "/api/healthz", { headers: { origin: TEST_ORIGIN } });
    expect(res.status).toBe(405);
  });
});
