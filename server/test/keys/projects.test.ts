import { describe, expect, it } from "vitest";
import { testApp } from "../harness.ts";
import { count, people, seedOrg } from "./helpers.ts";

describe("projects", () => {
  it("owners create, read, patch environments and list; slug reuse is 409 slug_taken", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    const base = `/api/orgs/${org.slug}/projects`;

    const created = await p.owner.call("POST", base, { slug: "shop", name: "Shop", environments: ["dev", "prod"] });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ slug: "shop", name: "Shop", environments: ["dev", "prod"], role: "admin" });

    const dup = await p.owner.call("POST", base, { slug: "shop" });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe("slug_taken");

    const patched = await p.owner.call("PATCH", `${base}/shop`, { environments: ["prod"] });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { environments: string[] }).environments).toEqual(["prod"]);

    const envs = await p.owner.call("GET", `${base}/shop/environments`);
    expect(await envs.json()).toEqual({ items: ["prod"] });

    const list = (await (await p.owner.call("GET", base)).json()) as { items: { slug: string }[] };
    expect(list.items.map((x) => x.slug)).toContain("shop");
  });

  it("validates bodies with 422 invalid", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    const res = await p.owner.call("POST", `/api/orgs/${org.slug}/projects`, { slug: "Bad Slug!" });
    expect(res.status).toBe(422);
    const patch = await p.owner.call("PATCH", `/api/orgs/${org.slug}/projects/default`, { environments: [""] });
    expect(patch.status).toBe(422);
  });

  it("members see only granted projects; grant role controls patch; create and delete need admin", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    await p.owner.call("POST", `/api/orgs/${org.slug}/projects`, { slug: "shop" });
    await p.owner.call("POST", `/api/orgs/${org.slug}/projects`, { slug: "blog" });

    // The member has no grants: sees nothing and cannot read a project directly.
    expect(((await (await p.member.call("GET", `/api/orgs/${org.slug}/projects`)).json()) as { items: unknown[] }).items).toEqual([]);
    expect((await p.member.call("GET", `/api/orgs/${org.slug}/projects/shop`)).status).toBe(404);

    await app.deps.storage.db.run("INSERT INTO project_grants (org_id, user_id, project, role) VALUES (?, ?, 'shop', 'viewer')", [
      org.orgId,
      p.memberId,
    ]);
    const visible = (await (await p.member.call("GET", `/api/orgs/${org.slug}/projects`)).json()) as { items: { slug: string; role: string }[] };
    expect(visible.items).toEqual([expect.objectContaining({ slug: "shop", role: "viewer" })]);
    expect((await p.member.call("PATCH", `/api/orgs/${org.slug}/projects/shop`, { name: "x" })).status).toBe(403);
    expect((await p.member.call("POST", `/api/orgs/${org.slug}/projects`, { slug: "new" })).status).toBe(403);
    expect((await p.member.call("DELETE", `/api/orgs/${org.slug}/projects/shop`)).status).toBe(403);
  });

  it("delete removes the project and its grants; a second delete is 404", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    await p.owner.call("POST", `/api/orgs/${org.slug}/projects`, { slug: "tmp" });
    await app.deps.storage.db.run("INSERT INTO project_grants (org_id, user_id, project, role) VALUES (?, ?, 'tmp', 'admin')", [
      org.orgId,
      p.memberId,
    ]);
    expect((await p.owner.call("DELETE", `/api/orgs/${org.slug}/projects/tmp`)).status).toBe(204);
    expect(await count(app, "SELECT COUNT(*) AS n FROM project_grants WHERE project = 'tmp'")).toBe(0);
    expect((await p.owner.call("DELETE", `/api/orgs/${org.slug}/projects/tmp`)).status).toBe(404);
  });

  it("a granted project admin may update but not delete", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    await p.owner.call("POST", `/api/orgs/${org.slug}/projects`, { slug: "shop" });
    await app.deps.storage.db.run("INSERT INTO project_grants (org_id, user_id, project, role) VALUES (?, ?, 'shop', 'admin')", [
      org.orgId,
      p.memberId,
    ]);
    expect((await p.member.call("PATCH", `/api/orgs/${org.slug}/projects/shop`, { name: "Renamed" })).status).toBe(200);
    expect((await p.member.call("DELETE", `/api/orgs/${org.slug}/projects/shop`)).status).toBe(403);
  });
});

describe("project audit", () => {
  it("create, update and delete each write an org-scoped audit row with the actor", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    const base = `/api/orgs/${org.slug}/projects`;
    expect((await p.owner.call("POST", base, { slug: "shop" })).status).toBe(201);
    expect((await p.owner.call("PATCH", `${base}/shop`, { name: "Shop" })).status).toBe(200);
    expect((await p.owner.call("DELETE", `${base}/shop`)).status).toBe(204);
    const rows = await app.deps.storage.db.all<{ action: string; target: string; org_id: string; actor_id: string | null }>(
      "SELECT action, target, org_id, actor_id FROM audit WHERE action LIKE 'project.%' ORDER BY rowid",
    );
    expect(rows.map((r) => r.action)).toEqual(["project.create", "project.update", "project.delete"]);
    for (const r of rows) expect(r).toMatchObject({ target: "shop", org_id: org.orgId, actor_id: expect.any(String) });
  });

  it("a rejected create writes no audit row", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    await p.member.call("POST", `/api/orgs/${org.slug}/projects`, { slug: "nope" });
    expect(await count(app, "SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'project.%'")).toBe(0);
  });
});
