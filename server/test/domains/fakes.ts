// Test doubles for the domain module: a host-aware RtCtl (operator routes only), an
// app lookup, and a TXT zone. Shared by domains, jobs and tls tests.
import type { CtlReq, CtlRes, RtCtl } from "../../src/runtime/types.ts";
import type { AppLookup, TxtLookup } from "../../src/domains/types.ts";
import { ensureMigrated } from "../../src/db/migrate.ts";
import type { Db } from "../../src/storage/types.ts";
import { addUser, signIn, testApp, type Client } from "../auth/helpers.ts";
import type { TestApp } from "../harness.ts";

export const ORG = { id: "org_1", slug: "acme" };
export const APP = { serviceId: "svc_shop", slug: "shop", projectSlug: "web" };

export interface HostsCtl extends RtCtl {
  /** Recorded control calls, in order. */
  calls: CtlReq[];
  /** Hosts currently mapped on the runtime. */
  hosts: Map<string, string>;
  /** Next N PUT/DELETE calls fail with this HTTP status (503 = transient). */
  failNext(status: number, method?: "PUT" | "DELETE"): void;
  /** Host held by another tenant: PUT answers 409 host_taken. */
  takeHost(host: string): void;
}

export function hostsCtl(): HostsCtl {
  const calls: CtlReq[] = [];
  const hosts = new Map<string, string>();
  const taken = new Set<string>();
  const fails: { status: number; method?: string }[] = [];
  const ctl: HostsCtl = {
    calls,
    hosts,
    failNext(status, method) {
      fails.push({ status, ...(method ? { method } : {}) });
    },
    takeHost(host) {
      taken.add(host);
    },
    async op(req): Promise<CtlRes> {
      calls.push(req);
      const f = fails.findIndex((x) => !x.method || x.method === req.method);
      if (f >= 0) {
        const [x] = fails.splice(f, 1);
        return { status: x?.status ?? 503, headers: {}, body: { error: { code: "overloaded", message: "overloaded" } } };
      }
      const m = /^\/v1\/services\/([^/]+)\/hosts\/(.+)$/.exec(req.path);
      if (!m) {
        if (req.method === "GET" && /\/hosts$/.test(req.path)) {
          const svc = req.path.split("/")[3] ?? "";
          const list = [...hosts].filter(([, s]) => s === svc).map(([h]) => ({ host: h, status: "active" }));
          return { status: 200, headers: {}, body: list };
        }
        return { status: 404, headers: {}, body: { error: { code: "not_found", message: "nf" } } };
      }
      const svc = m[1] ?? "";
      const host = decodeURIComponent(m[2] ?? "");
      if (req.method === "PUT") {
        if (taken.has(host)) return { status: 409, headers: {}, body: { error: { code: "host_taken", message: "held" } } };
        hosts.set(host, svc);
        return { status: 200, headers: {}, body: { host, status: "active", verify_token: null, created_at: 0, expires_at: null } };
      }
      if (req.method === "DELETE") {
        if (!hosts.has(host)) return { status: 404, headers: {}, body: { error: { code: "not_found", message: "nf" } } };
        hosts.delete(host);
        return { status: 204, headers: {}, body: null };
      }
      return { status: 405, headers: {}, body: null };
    },
    async tenant(): Promise<CtlRes> {
      throw new Error("tenant scope not used by domains");
    },
  };
  return ctl;
}

export function appsFake(): AppLookup {
  return {
    async resolve(orgId, slug) {
      return orgId === ORG.id && slug === APP.slug ? APP : null;
    },
  };
}

/** TXT zone: name → values. */
export function zone(): { txt: TxtLookup; set(name: string, values: string[]): void } {
  const z = new Map<string, string[]>();
  return {
    txt: async (name) => z.get(name) ?? [],
    set: (name, values) => void z.set(name, values),
  };
}

export interface Seeded {
  app: TestApp;
  db: Db;
  rt: HostsCtl;
  zone: ReturnType<typeof zone>;
  owner: Client;
  dev: Client;
  viewer: Client;
  outsider: Client;
  ownerId: string;
  /** Second org with its own owner, to test cross-org isolation. */
  other: Client;
}

/** Org acme (owner, developer, viewer, outsider) with app shop in project web. */
export async function seed(over: Parameters<typeof testApp>[0] = {}): Promise<Seeded> {
  const rt = hostsCtl();
  const z = zone();
  const app = testApp({ rtctl: rt, apps: appsFake(), txt: z.txt, ...over });
  await ensureMigrated(app.deps.storage.db);
  const db = app.deps.storage.db;
  const ownerId = await addUser(app, "owner@acme.test");
  const devId = await addUser(app, "dev@acme.test");
  const viewerId = await addUser(app, "viewer@acme.test");
  await addUser(app, "outsider@acme.test");
  const otherId = await addUser(app, "owner@beta.test");
  const now = app.deps.now();
  await db.run("INSERT INTO orgs (id, slug, name, tenant_id, created_at) VALUES (?, 'acme', 'Acme', 't_acme', ?)", [ORG.id, now]);
  await db.run("INSERT INTO orgs (id, slug, name, tenant_id, created_at) VALUES ('org_2', 'beta', 'Beta', 't_beta', ?)", [now]);
  await db.run("INSERT INTO members (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", [ORG.id, ownerId, now]);
  await db.run("INSERT INTO members (org_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", [ORG.id, devId, now]);
  await db.run("INSERT INTO members (org_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", [ORG.id, viewerId, now]);
  await db.run("INSERT INTO members (org_id, user_id, role, created_at) VALUES ('org_2', ?, 'owner', ?)", [otherId, now]);
  await db.run("INSERT INTO project_grants (org_id, user_id, project, role) VALUES (?, ?, 'web', 'developer')", [ORG.id, devId]);
  await db.run("INSERT INTO project_grants (org_id, user_id, project, role) VALUES (?, ?, 'web', 'viewer')", [ORG.id, viewerId]);
  return {
    app,
    db,
    rt,
    zone: z,
    ownerId,
    owner: await signIn(app, "owner@acme.test"),
    dev: await signIn(app, "dev@acme.test"),
    viewer: await signIn(app, "viewer@acme.test"),
    outsider: await signIn(app, "outsider@acme.test"),
    other: await signIn(app, "owner@beta.test"),
  };
}

export const DOMAINS = `/api/orgs/${ORG.slug}/apps/${APP.slug}/domains`;
