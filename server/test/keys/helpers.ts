// Fixtures for T6 tests: an org wired to a FakeRtCtl tenant whose default key is
// sealed exactly as rotation does, plus members.

import { sealerOf } from "../../src/auth/types.ts";
import { ensureMigrated } from "../../src/db/migrate.ts";
import type { FakeRtCtl } from "../fakes/rtctl.ts";
import { addUser, signIn, type Client } from "../auth/helpers.ts";
import type { TestApp } from "../harness.ts";

export interface SeededOrg {
  orgId: string;
  slug: string;
  tenantId: string;
  defaultKeyId: string;
  defaultKey: string;
}

export function fake(app: TestApp): FakeRtCtl {
  return app.deps.rtctl as FakeRtCtl;
}

export async function seedOrg(app: TestApp, slug = "acme"): Promise<SeededOrg> {
  await ensureMigrated(app.deps.storage.db);
  fake(app).now = app.deps.now;
  const { tenant, key, keyId } = fake(app).seedTenant(`tenant-${slug}`);
  const sealed = await (await sealerOf(app.deps)).seal(new TextEncoder().encode(key));
  const orgId = `org_${slug}`;
  await app.deps.storage.db.run(
    "INSERT INTO orgs (id, slug, name, tenant_id, default_key_id, default_key_sealed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [orgId, slug, slug, tenant.id, keyId, sealed, app.deps.now()],
  );
  return { orgId, slug, tenantId: tenant.id, defaultKeyId: keyId, defaultKey: key };
}

export async function addMember(app: TestApp, org: SeededOrg, userId: string, role: string): Promise<void> {
  await app.deps.storage.db.run("INSERT INTO members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", [
    org.orgId,
    userId,
    role,
    app.deps.now(),
  ]);
}

export interface People {
  owner: Client;
  ownerId: string;
  member: Client;
  memberId: string;
  outsider: Client;
  admin: Client;
  adminId: string;
}

/** owner (org owner), member (plain member), outsider (no membership), admin (instance admin). */
export async function people(app: TestApp, org: SeededOrg): Promise<People> {
  const ownerId = await addUser(app, "owner@example.com");
  const memberId = await addUser(app, "member@example.com");
  await addUser(app, "outsider@example.com");
  const adminId = await addUser(app, "instance@example.com", { admin: true });
  await addMember(app, org, ownerId, "owner");
  await addMember(app, org, memberId, "member");
  return {
    owner: await signIn(app, "owner@example.com"),
    ownerId,
    member: await signIn(app, "member@example.com"),
    memberId,
    outsider: await signIn(app, "outsider@example.com"),
    admin: await signIn(app, "instance@example.com"),
    adminId,
  };
}

export async function count(app: TestApp, sql: string, args: (string | number | null)[] = []): Promise<number> {
  const r = await app.deps.storage.db.first<{ n: number }>(sql, args);
  return Number(r?.n ?? 0);
}
