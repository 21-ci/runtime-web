// Review item 13: apps share the console's site, so SameSite=Lax lets App pages send GETs with the
// console cookie. Guard that no GET route changes state: every registered GET is called as an
// instance admin and the database (audit and session touch excluded) and the runtime (no
// non-GET call) must be unchanged.
import { describe, expect, it } from "vitest";
import { APPS, createApp, world } from "../apps/helpers.ts";

/** Tables a read may write: the audit of sensitive reads and the sliding session expiry. */
const MAY_CHANGE = new Set(["audit", "sessions"]);

const PARAMS: Record<string, string> = {
  org: "acme",
  app: "hello",
  p: "default",
  v: "1",
  id: "none",
  name: "API_KEY",
  provider: "github",
  token: "none",
  user: "none",
  kind: "logo",
  host: "none.example.org",
};

describe("GET routes do not mutate state", () => {
  it("leaves the database and the runtime unchanged", async () => {
    const w = await world();
    await createApp(w.admin);
    const db = w.app.deps.storage.db;
    const tables = (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"))
      .map((t) => t.name)
      .filter((t) => !MAY_CHANGE.has(t));
    const snapshot = async () => {
      const out: Record<string, unknown> = {};
      for (const t of tables) out[t] = await db.all(`SELECT * FROM ${t}`);
      return JSON.stringify(out);
    };
    const gets = w.app.routes().filter((r) => r.method === "GET" && r.pattern.startsWith("/api/"));
    expect(gets.length).toBeGreaterThan(30);
    const before = await snapshot();
    const runtimeCalls = w.fake.calls.length;
    for (const r of gets) {
      const path = r.pattern.replace(/:([a-z_]+)/gi, (_, k: string) => PARAMS[k] ?? "x");
      const res = await w.admin.call("GET", path);
      expect(res.status, `GET ${r.pattern}`).toBeLessThan(500);
      await res.arrayBuffer();
    }
    expect(await snapshot()).toBe(before);
    const writes = w.fake.calls.slice(runtimeCalls).filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual([]);
    expect((await w.admin.call("GET", `${APPS}/hello`)).status).toBe(200);
  });
});
