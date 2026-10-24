import { describe, expect, it } from "vitest";
import { testApp } from "../harness.ts";
import { people, seedOrg } from "./helpers.ts";

describe("limits and usage", () => {
  it("limits are the runtime quota view without the plan name", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    const res = await p.member.call("GET", `/api/orgs/${org.slug}/limits`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("plan");
    expect(body).toHaveProperty("invocations");
    expect(body).toHaveProperty("storage_bytes");
  });

  it("org usage needs org.usage.read (owners and admins) and validates the date range", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    expect((await p.member.call("GET", `/api/orgs/${org.slug}/usage`)).status).toBe(403);
    expect((await p.owner.call("GET", `/api/orgs/${org.slug}/usage?from=2026-1-1`)).status).toBe(422);
    const ok = await p.owner.call("GET", `/api/orgs/${org.slug}/usage?from=2026-01-01&to=2026-12-31`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ items: [] });
  });

  it("admin usage is instance-admin only, audited, and 404 for an unknown org", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    expect((await p.owner.call("GET", `/api/admin/orgs/${org.slug}/usage`)).status).toBe(403);
    expect((await p.admin.call("GET", "/api/admin/orgs/ghost/usage")).status).toBe(404);
    expect((await p.admin.call("GET", `/api/admin/orgs/${org.slug}/usage`)).status).toBe(200);
    const rows = await app.deps.storage.db.all<{ action: string }>("SELECT action FROM audit WHERE action = 'org.usage.read'");
    expect(rows).toHaveLength(1);
  });
});
