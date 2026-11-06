import { describe, expect, it } from "vitest";
import { audit } from "../../src/audit/audit.ts";
import { world } from "../apps/helpers.ts";

const ORG = "/api/orgs/acme";

async function seeded() {
  const w = await world();
  const owner = await w.user("o@example.com", "owner");
  const member = await w.user("m@example.com", "member");
  await audit(w.app.deps, { actor: {}, orgId: w.org.id, action: "app.create", target: "=evil", detail: { a: 1 } });
  await audit(w.app.deps, { actor: {}, orgId: w.org.id, action: "app.delete", target: "gone" });
  const other = await w.addOrg("beta");
  await audit(w.app.deps, { actor: {}, orgId: other.id, action: "app.create", target: "secret-other-org" });
  return { w, owner, member };
}

const count = async (w: Awaited<ReturnType<typeof world>>, action: string) =>
  (await w.app.deps.storage.db.all("SELECT id FROM audit WHERE action = ?", [action])).length;

describe("audit export", () => {
  it("exports this org as csv, defusing formulas, and audits the export", async () => {
    const { w, owner } = await seeded();
    const res = await owner.call("GET", `${ORG}/audit?format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="acme-audit-start-\d{8}T\d{6}Z\.csv"$/);
    const text = await res.text();
    expect(text.split("\r\n")[0]).toBe("at,actor,actor_email,actor_id,as_instance_admin,org,action,target,detail");
    expect(text).toContain("'=evil");
    expect(text).not.toContain("secret-other-org");
    expect(await count(w, "audit.export")).toBe(1);
  });

  it("honours the filters in ndjson and pages through everything", async () => {
    const { w, owner } = await seeded();
    for (let i = 0; i < 700; i++) await audit(w.app.deps, { actor: {}, orgId: w.org.id, action: "bulk.action", target: String(i) });
    const res = await owner.call("GET", `${ORG}/audit?format=ndjson&action=bulk.action`);
    const rows = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as { action: string });
    expect(rows).toHaveLength(700);
    expect(rows.every((r) => r.action === "bulk.action")).toBe(true);
  });

  it("filters the list and the export by since and until, and names the file by them", async () => {
    const { w, owner } = await seeded();
    const db = w.app.deps.storage.db;
    await db.run("UPDATE audit SET ts = ? WHERE action = ?", [Date.UTC(2026, 0, 1), "app.create"]);
    await db.run("UPDATE audit SET ts = ? WHERE action = ?", [Date.UTC(2026, 5, 1), "app.delete"]);
    const window = "since=2026-05-01T00:00:00Z&until=2026-07-01T00:00:00Z";
    const list = (await (await owner.call("GET", `${ORG}/audit?${window}`)).json()) as { items: { action: string }[] };
    expect(list.items.map((e) => e.action)).toEqual(["app.delete"]);
    const after = (await (await owner.call("GET", `${ORG}/audit?since=2026-05-01T00:00:00Z`)).json()) as { items: { action: string }[] };
    expect(after.items.map((e) => e.action)).toEqual(["app.delete"]);
    const before = (await (await owner.call("GET", `${ORG}/audit?until=2026-02-01T00:00:00Z`)).json()) as { items: { action: string }[] };
    expect(before.items.map((e) => e.action)).toEqual(["app.create"]);
    const file = await owner.call("GET", `${ORG}/audit?format=ndjson&${window}`);
    expect(file.headers.get("content-disposition")).toContain("acme-audit-20260501T000000Z-20260701T000000Z.ndjson");
    const rows = (await file.text()).trim().split("\n").map((l) => JSON.parse(l) as { action: string });
    expect(rows.map((r) => r.action)).toEqual(["app.delete"]);
    expect((await owner.call("GET", `${ORG}/audit?since=yesterday`)).status).toBe(422);
  });

  it("needs org.audit.read and rejects an unknown format", async () => {
    const { w, owner, member } = await seeded();
    expect((await member.call("GET", `${ORG}/audit?format=csv`)).status).toBe(403);
    expect((await owner.call("GET", `${ORG}/audit?format=xlsx`)).status).toBe(422);
    expect(await count(w, "audit.export")).toBe(0);
  });

  it("is instance-admin only for the whole instance", async () => {
    const { w, owner } = await seeded();
    expect((await owner.call("GET", "/api/admin/audit?format=csv")).status).toBe(403);
    const all = await w.admin.call("GET", "/api/admin/audit?format=csv");
    expect(all.status).toBe(200);
    expect(all.headers.get("content-disposition")).toContain('filename="instance-audit-');
    expect(await all.text()).toContain("secret-other-org");
    const one = await w.admin.call("GET", "/api/admin/audit?format=ndjson&org=beta");
    expect(one.headers.get("content-disposition")).toContain('filename="beta-audit-');
    expect(await count(w, "audit.export")).toBe(2);
  });
});

describe("members and tokens export", () => {
  it("exports members as csv, audited, and refuses another format", async () => {
    const { w, owner } = await seeded();
    expect((await owner.call("GET", `${ORG}/members?format=ndjson`)).status).toBe(422);
    const res = await owner.call("GET", `${ORG}/members?format=csv`);
    expect(res.headers.get("content-disposition")).toContain('filename="acme-members-start-');
    const text = await res.text();
    expect(text.split("\r\n")[0]).toBe("name,email,role,grants");
    expect(text).toContain("m@example.com");
    expect(await count(w, "org.members.export")).toBe(1);
  });

  it("exports tokens without any secret, for those who manage them", async () => {
    const { w, owner, member } = await seeded();
    const created = await owner.call("POST", `${ORG}/tokens`, { name: "ci", scopes: ["app.logs.read"], projects: [], environments: [], expires_at: null });
    const secret = ((await created.json()) as { secret?: string }).secret;
    expect((await member.call("GET", `${ORG}/tokens?format=csv`)).status).toBe(403);
    const res = await owner.call("GET", `${ORG}/tokens?format=csv`);
    const text = await res.text();
    expect(text.split("\r\n")[0]).toBe("name,scopes,projects,environments,created_by,created_at,expires_at,last_used_at");
    if (secret) expect(text).not.toContain(secret);
    expect(await count(w, "org.tokens.export")).toBe(1);
  });
});

describe("usage export", () => {
  it("exports usage as csv with a range, audited, for those who can read it", async () => {
    const { w, owner, member } = await seeded();
    expect((await member.call("GET", `${ORG}/usage?format=csv`)).status).toBe(403);
    expect((await owner.call("GET", `${ORG}/usage?format=ndjson`)).status).toBe(422);
    expect((await owner.call("GET", `${ORG}/usage?format=csv&from=nope`)).status).toBe(422);
    const res = await owner.call("GET", `${ORG}/usage?format=csv&from=2026-01-01&to=2026-12-31`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('filename="acme-usage-20260101T000000Z-20261231T000000Z.csv"');
    expect((await res.text()).split("\r\n")[0]).toBe("app,day,invocations,cpu_ms,egress_bytes,storage_bytes");
    expect(await count(w, "org.usage.export")).toBe(1);
  });

  it("the instance-admin read exports too, audited as an export", async () => {
    const { w, owner } = await seeded();
    expect((await owner.call("GET", "/api/admin/orgs/acme/usage?format=csv")).status).toBe(403);
    const res = await w.admin.call("GET", "/api/admin/orgs/acme/usage?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(await count(w, "org.usage.export")).toBe(1);
  });
});
