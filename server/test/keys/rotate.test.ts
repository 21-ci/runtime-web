import { describe, expect, it } from "vitest";
import { retryPendingRevokes, rotateDefaultKey } from "../../src/keys/keys.ts";
import { getOrgBySlug } from "../../src/orgs/orgs.ts";
import { testApp } from "../harness.ts";
import { count, fake, people, seedOrg } from "./helpers.ts";

type Rec = { id: string; revoked: boolean };
const keyById = (app: ReturnType<typeof testApp>, id: string) => fake(app).keys.get(id) as unknown as Rec;

describe("default key rotation", () => {
  it("swaps the default key, keeps custom tokens working, and revokes the old key", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    await p.owner.call("POST", `/api/orgs/${org.slug}/tokens`, { name: "keep", scopes: ["deploy"] });
    const customId = [...fake(app).keys.values()].find((k) => k.name === "keep")?.id as string;

    const res = await p.owner.call("POST", `/api/orgs/${org.slug}/default-key/rotate`);
    expect(res.status).toBe(204);

    const row = await app.deps.storage.db.first<{ default_key_id: string }>("SELECT default_key_id FROM orgs WHERE id = ?", [org.orgId]);
    expect(row?.default_key_id).not.toBe(org.defaultKeyId);
    expect(keyById(app, org.defaultKeyId).revoked).toBe(true);
    expect(keyById(app, customId).revoked).toBe(false);
    expect(await count(app, "SELECT COUNT(*) AS n FROM pending_key_revokes")).toBe(0);

    // The custom token still lists and the org still resolves its (new) default key.
    const list = (await (await p.owner.call("GET", `/api/orgs/${org.slug}/tokens`)).json()) as { items: { id: string }[] };
    expect(list.items).toHaveLength(1);
    const limits = await p.owner.call("GET", `/api/orgs/${org.slug}/limits`);
    expect(limits.status).toBe(200);
  });

  it("rotation fails with 409 when the stored key changed underneath, and the minted key is revoked", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const row = await getOrgBySlug(app.deps.storage.db, org.slug);
    if (!row) throw new Error("org missing");
    const stale = { ...row, defaultKeyId: "key_stale" };
    const before = fake(app).keys.size;

    await expect(rotateDefaultKey(app.deps, { id: "usr_x", name: "x" }, stale)).rejects.toMatchObject({
      status: 409,
      code: "rotation_in_progress",
    });
    expect(fake(app).keys.size).toBe(before + 1);
    const minted = [...fake(app).keys.values()].pop() as unknown as Rec;
    expect(minted.revoked).toBe(true);
    const stored = await app.deps.storage.db.first<{ default_key_id: string }>("SELECT default_key_id FROM orgs WHERE id = ?", [org.orgId]);
    expect(stored?.default_key_id).toBe(org.defaultKeyId);
  });

  it("a failed revoke of the old key is queued in pending_key_revokes and retried later", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    fake(app).failNext({
      status: 503,
      code: "unavailable",
      match: (r) => r.method === "DELETE" && r.path.includes(`/keys/${org.defaultKeyId}`),
    });

    const res = await p.owner.call("POST", `/api/orgs/${org.slug}/default-key/rotate`);
    expect(res.status).toBe(204);
    const pending = await app.deps.storage.db.all<{ runtime_key_id: string; attempts: number }>(
      "SELECT runtime_key_id, attempts FROM pending_key_revokes",
    );
    expect(pending).toEqual([{ runtime_key_id: org.defaultKeyId, attempts: 1 }]);
    expect(keyById(app, org.defaultKeyId).revoked).toBe(false);

    // Not due yet: nothing retried.
    expect(await retryPendingRevokes(app.deps)).toBe(0);
    app.tick(10 * 60_000);
    expect(await retryPendingRevokes(app.deps)).toBe(1);
    expect(keyById(app, org.defaultKeyId).revoked).toBe(true);
    expect(await count(app, "SELECT COUNT(*) AS n FROM pending_key_revokes")).toBe(0);
  });

  it("only owners and admins may rotate; members get 403 and outsiders 404", async () => {
    const app = testApp();
    const org = await seedOrg(app);
    const p = await people(app, org);
    expect((await p.member.call("POST", `/api/orgs/${org.slug}/default-key/rotate`)).status).toBe(403);
    expect((await p.outsider.call("POST", `/api/orgs/${org.slug}/default-key/rotate`)).status).toBe(404);
  });
});
