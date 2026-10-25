import { describe, expect, it } from "vitest";

// Runs against a deployed app: RT_INVOKE=http://127.0.0.1:8080 RTWEB_SLUG=rtweb.
// `npm run deploy` first. Skipped when RT_INVOKE is unset.
const invoke = process.env.RT_INVOKE;
const slug = process.env.RTWEB_SLUG ?? "rtweb";

describe.skipIf(!invoke)("deployed app", () => {
  it("answers GET /api/healthz with a working database", async () => {
    const res = await fetch(`${invoke}/s/${slug}/api/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, db: true });
  });
});
