import { expect } from "vitest";
import type { FakeRtCtl } from "../fakes/rtctl.ts";
import { addUser, setupAdmin, signIn, testApp, type Client } from "../auth/helpers.ts";
import type { TestApp } from "../harness.ts";
import { Runtime } from "../../src/runtime/client.ts";
import { defaultKey, getOrgBySlug } from "../../src/orgs/orgs.ts";

export interface World {
  app: TestApp;
  fake: FakeRtCtl;
  admin: Client;
}

export async function world(): Promise<World> {
  const app = testApp();
  const admin = await setupAdmin(app);
  return { app, fake: app.deps.rtctl as FakeRtCtl, admin };
}

/** Creates an org owned by ownerId through the admin API. */
export async function makeOrg(w: World, slug: string, ownerId: string): Promise<string> {
  const res = await w.admin.call("POST", "/api/admin/orgs", { slug, name: slug.toUpperCase(), owner_user_id: ownerId });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** A signed-in user (created directly) with optional org membership. */
export async function member(w: World, email: string, org?: string, role?: string): Promise<{ id: string; c: Client }> {
  const id = await addUser(w.app, email);
  if (org && role) {
    const res = await w.admin.call("POST", `/api/orgs/${org}/members`, { user_id: id, role });
    expect(res.status).toBe(201);
  }
  return { id, c: await signIn(w.app, email) };
}

/** Creates a runtime project in the org's tenant with its default key. */
export async function project(w: World, org: string, slug: string): Promise<void> {
  const db = w.app.deps.storage.db;
  const o = await getOrgBySlug(db, org);
  const key = await defaultKey(w.app.deps, (o as { id: string }).id);
  await new Runtime(w.fake).as(key).createProject({ slug, name: slug } as never);
}

export async function adminId(w: World): Promise<string> {
  const me = await w.admin.call("GET", "/api/me");
  return ((await me.json()) as { user: { id: string } }).user.id;
}
