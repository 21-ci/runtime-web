import { expect } from "vitest";
import { addUser, setupAdmin, signIn, testApp, type Client } from "../auth/helpers.ts";
import { FakeRtCtl } from "../fakes/rtctl.ts";
import { createSealer } from "../../src/crypto/seal.ts";
import { ensureMigrated } from "../../src/db/migrate.ts";
import { CHUNK, type RtCtl, type WireReq, type WireRes } from "../../src/runtime/types.ts";
import type { SdkHandle } from "../../src/runtime/client.ts";
import type { TestApp } from "../harness.ts";
import type { Deps } from "../../src/app.ts";
import { timing } from "../../src/apps/service.ts";
import { sseTiming } from "../../src/apps/logs.ts";

export interface World {
  app: TestApp;
  fake: FakeRtCtl;
  admin: Client;
  org: { id: string; slug: string; tenant: string };
  /** Creates a user with an org role (and optional project grants) and signs in. */
  user(email: string, role: "owner" | "admin" | "member" | null, grants?: Record<string, string>): Promise<Client>;
  /** Seeds another org with its own tenant. */
  addOrg(slug: string): Promise<{ id: string; tenant: string }>;
}

/** A stand-in for sdk("rtctl") answering from a FakeRtCtl and chunking like sdk/rtctl/mod.ts. */
export function sdkHandle(fake: RtCtl, log: string[] = []): SdkHandle {
  const store = new Map<string, string>();
  let n = 0;
  const answer = async (scope: "op" | "tenant", w: WireReq): Promise<WireRes> => {
    let body = w.body;
    if (w.bodyRef) body = Array.from({ length: w.bodyRef.parts }, (_, i) => store.get(`in:${w.bodyRef?.id}:${i}`) ?? "").join("");
    const req = {
      method: w.method, path: w.path, query: w.query, headers: { ...w.headers, ...(w.contentType ? { "content-type": w.contentType } : {}) },
      // version uploads stay text (the control API reads the raw source)
      body: body !== undefined && w.contentType === "application/json" && !w.path.endsWith("/versions") ? JSON.parse(body) : body,
    };
    const res = scope === "op" ? await fake.op(req) : await fake.tenant(w.key ?? "", req);
    const text = res.body === null ? "" : typeof res.body === "string" ? res.body : JSON.stringify(res.body);
    if (text.length <= CHUNK) return { status: res.status, headers: res.headers, body: text, ...(res.encoding ? { encoding: res.encoding } : {}) };
    const id = `r${++n}`;
    const parts = Math.ceil(text.length / CHUNK);
    for (let i = 0; i < parts; i++) store.set(`out:${id}:${i}`, text.slice(i * CHUNK, (i + 1) * CHUNK));
    log.push(`chunked-out:${parts}`);
    return { status: res.status, headers: res.headers, chunked: { id, parts } };
  };
  return {
    op: async (a) => answer("op", a as WireReq),
    tenant: async (a) => answer("tenant", a as WireReq),
    put: async (a) => {
      const { id, index, data } = a as { id: string; index: number; data: string };
      expect(data.length).toBeLessThanOrEqual(CHUNK);
      log.push(`put${index}`);
      store.set(`in:${id}:${index}`, data);
      return { ok: true };
    },
    get: async (a) => {
      const { id, index } = a as { id: string; index: number };
      return { data: store.get(`out:${id}:${index}`) };
    },
  };
}

export async function world(over: Partial<Deps> & { fake?: FakeRtCtl } = {}): Promise<World> {
  const fake = over.fake ?? new FakeRtCtl();
  const { fake: _f, ...rest } = over;
  void _f;
  const app = testApp({ rtctl: fake, ...rest });
  fake.now = app.deps.now;
  timing.sleep = async (ms) => app.tick(ms);
  sseTiming.sleep = async (ms) => app.tick(ms);
  await ensureMigrated(app.deps.storage.db);
  const admin = await setupAdmin(app);
  const sealer = await createSealer(app.deps.config.sealKey);
  const addOrg = async (slug: string) => {
    const t = fake.seedTenant(`org-${slug}`);
    const id = `org_${slug}`;
    await app.deps.storage.db.run(
      "INSERT INTO orgs (id, slug, name, tenant_id, default_key_id, default_key_sealed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, slug, slug, t.tenant.id, t.keyId, await sealer.seal(new TextEncoder().encode(t.key)), app.deps.now()],
    );
    return { id, tenant: t.tenant.id };
  };
  const o = await addOrg("acme");
  const user = async (email: string, role: "owner" | "admin" | "member" | null, grants: Record<string, string> = {}) => {
    const uid = await addUser(app, email);
    if (role) await app.deps.storage.db.run("INSERT INTO members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", [o.id, uid, role, 0]);
    for (const [p, r] of Object.entries(grants)) {
      await app.deps.storage.db.run("INSERT INTO project_grants (org_id, user_id, project, role) VALUES (?, ?, ?, ?)", [o.id, uid, p, r]);
    }
    return signIn(app, email);
  };
  return { app, fake, admin, org: { id: o.id, slug: "acme", tenant: o.tenant }, user, addOrg };
}

export const APPS = "/api/orgs/acme/apps";

export async function createApp(c: Client, slug = "hello", template = "http"): Promise<{ etag: string; body: Record<string, unknown> }> {
  const res = await c.call("POST", APPS, { project: "default", environment: "production", slug, template });
  expect(res.status, await res.clone().text()).toBe(201);
  return { etag: res.headers.get("etag") ?? "", body: (await res.json()) as Record<string, unknown> };
}

export async function errOf(res: Response): Promise<{ code: string; details?: Record<string, unknown> }> {
  return ((await res.json()) as { error: { code: string; details?: Record<string, unknown> } }).error;
}
