import { describe, expect, it } from "vitest";
import { testApp } from "../harness.ts";
import { count, fake, people, seedOrg } from "./helpers.ts";

describe("custom tokens", () => {
  it("lists only custom tokens, never the hidden default key", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);

    const empty = await p.owner.call("GET", `/api/orgs/${org.slug}/tokens`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ items: [] });

    const created = await p.owner.call("POST", `/api/orgs/${org.slug}/tokens`, { name: "ci", scopes: ["deploy"] });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { token: { id: string; name: string }; secret: string };
    expect(body.secret.startsWith("rtk_")).toBe(true);
    expect(body.token.name).toBe("ci");

    const list = await p.owner.call("GET", `/api/orgs/${org.slug}/tokens`);
    const items = ((await list.json()) as { items: { id: string }[] }).items;
    expect(items.map((t) => t.id)).toEqual([body.token.id]);
    expect(JSON.stringify(items)).not.toContain(org.defaultKeyId);
    expect(JSON.stringify(items)).not.toContain(org.defaultKey);
  });

  it("mints with projects and environments restriction and records the audit row", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    const res = await p.owner.call("POST", `/api/orgs/${org.slug}/tokens`, {
      name: "scoped",
      scopes: ["deploy", "invoke"],
      projects: ["default"],
      environments: ["prod"],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: { projects: string[]; environments: string[]; created_by: { id: string } } };
    expect(body.token.projects).toEqual(["default"]);
    expect(body.token.environments).toEqual(["prod"]);
    expect(body.token.created_by.id).toBe(p.ownerId);

    const minted = [...fake(app).keys.values()].find((k) => k.tenant === org.tenantId && k.name === "scoped");
    expect(minted?.environments).toEqual(["prod"]);
    expect(minted?.project_ids).toHaveLength(1);
    expect(await count(app, "SELECT COUNT(*) AS n FROM audit WHERE action = 'token.create' AND org_id = ?", [org.orgId])).toBe(1);
  });

  it("rejects unknown and keys:write scopes, blank names and past expiry with 422 invalid", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    const url = `/api/orgs/${org.slug}/tokens`;
    for (const bad of [
      { name: "x", scopes: ["keys:write"] },
      { name: "x", scopes: ["nope"] },
      { name: "x", scopes: [] },
      { name: "  ", scopes: ["deploy"] },
      { name: "x", scopes: ["deploy"], expires_at: app.deps.now() - 1 },
    ]) {
      const res = await p.owner.call("POST", url, bad);
      expect(res.status, JSON.stringify(bad)).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid");
    }
  });

  it("returns 404 for an unknown project slug", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    const res = await p.owner.call("POST", `/api/orgs/${org.slug}/tokens`, { name: "x", scopes: ["deploy"], projects: ["ghost"] });
    expect(res.status).toBe(404);
  });

  it("a plain member cannot manage tokens (403) and a non-member sees 404", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    expect((await p.member.call("GET", `/api/orgs/${org.slug}/tokens`)).status).toBe(403);
    expect((await p.member.call("POST", `/api/orgs/${org.slug}/tokens`, { name: "x", scopes: ["deploy"] })).status).toBe(403);
    expect((await p.outsider.call("GET", `/api/orgs/${org.slug}/tokens`)).status).toBe(404);
  });

  it("instance admins may manage any org's tokens", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    expect((await p.admin.call("GET", `/api/orgs/${org.slug}/tokens`)).status).toBe(200);
  });

  it("requires a CSRF token on mutations", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    const res = await app.call("POST", `/api/orgs/${org.slug}/tokens`, {
      body: { name: "x", scopes: ["deploy"] },
      headers: { origin: "https://console.test", cookie: p.owner.cookie },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("csrf_invalid");
  });

  it("revoke removes the token from the list, revokes the runtime key, and a second revoke is 404", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    const made = (await (await p.owner.call("POST", `/api/orgs/${org.slug}/tokens`, { name: "gone", scopes: ["deploy"] })).json()) as {
      token: { id: string };
    };
    const minted = [...fake(app).keys.values()].find((k) => k.tenant === org.tenantId && k.name === "gone") as { id: string; revoked: boolean };

    const del = await p.owner.call("DELETE", `/api/orgs/${org.slug}/tokens/${made.token.id}`);
    expect(del.status).toBe(204);
    expect(minted.revoked).toBe(true);

    const list = (await (await p.owner.call("GET", `/api/orgs/${org.slug}/tokens`)).json()) as { items: unknown[] };
    expect(list.items).toEqual([]);
    expect((await p.owner.call("DELETE", `/api/orgs/${org.slug}/tokens/${made.token.id}`)).status).toBe(404);
  });

  it("accepts a future expiry and returns it", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    const exp = app.deps.now() + 3600_000;
    const res = await p.owner.call("POST", `/api/orgs/${org.slug}/tokens`, { name: "soon", scopes: ["deploy"], expires_at: exp });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { token: { expires_at: number } }).token.expires_at).toBe(exp);
  });
});
