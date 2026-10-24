import { DatabaseSync } from "node:sqlite";
import { FakeRtCtl } from "./fakes/rtctl.ts";
import { createApp, type App, type Deps } from "../src/app.ts";
import type { Db, Kv, Row, SqlArg, Storage, Tx } from "../src/storage/types.ts";
import type { Config } from "../src/config.ts";
import type { Hasher } from "../src/auth/password.ts";
import { verifyPassword } from "../src/crypto/password.ts";
import { argon2id } from "hash-wasm";
import { randomBytes } from "../src/crypto/random.ts";

export const TEST_ORIGIN = "https://console.test";
export const TEST_SETUP_TOKEN = "test-setup-token-0123456789abcdef";

export function testConfig(over: Partial<Config> = {}): Config {
  return { origin: TEST_ORIGIN, sealKey: new Uint8Array(32).fill(7), insecureCookies: false, setupToken: TEST_SETUP_TOKEN, ...over };
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/=+$/, "");

/** argon2id with tiny parameters (still a valid PHC string the real verifier accepts). */
export const fastHasher: Hasher = {
  async hash(password) {
    const salt = randomBytes(16);
    const key = await argon2id({ password, salt, memorySize: 8, iterations: 1, parallelism: 1, hashLength: 32, outputType: "binary" });
    return `$argon2id$v=19$m=8,t=1,p=1$${b64(salt)}$${b64(key)}`;
  },
  verify: verifyPassword,
};

// Unit-test harness: the real app over node:sqlite (same SQLite dialect as the
// runtime's std:sql) and a Map-backed KV with a controllable clock.

export function memoryStorage(now: () => number = Date.now): Storage {
  const sq = new DatabaseSync(":memory:");
  const norm = (a: SqlArg[] = []) => a.map((v) => (typeof v === "boolean" ? Number(v) : v));
  const tx: Tx = {
    all: async <T extends Row>(q: string, a?: SqlArg[]) => sq.prepare(q).all(...norm(a)) as T[],
    run: async (q, a) => {
      const r = sq.prepare(q).run(...norm(a));
      return { changes: Number(r.changes), lastId: r.lastInsertRowid };
    },
  };
  const db: Db = {
    ...tx,
    first: async <T extends Row>(q: string, a?: SqlArg[]) => ((await tx.all<T>(q, a))[0] ?? null),
    batch: async (stmts) => {
      sq.exec("BEGIN");
      try {
        for (const s of stmts) sq.prepare(s.sql).run(...norm(s.args));
        sq.exec("COMMIT");
      } catch (e) {
        sq.exec("ROLLBACK");
        throw e;
      }
    },
    tx: async (fn) => {
      sq.exec("BEGIN");
      try {
        const v = await fn(tx);
        sq.exec("COMMIT");
        return v;
      } catch (e) {
        sq.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const m = new Map<string, { v: unknown; exp: number | null }>();
  const live = (k: string) => {
    const e = m.get(k);
    if (!e) return null;
    if (e.exp !== null && e.exp <= now()) {
      m.delete(k);
      return null;
    }
    return e;
  };
  const kv: Kv = {
    get: async <T>(k: string) => (live(k)?.v ?? null) as T | null,
    set: async (k, v, o) => void m.set(k, { v: structuredClone(v), exp: o?.ttlSeconds ? now() + o.ttlSeconds * 1000 : null }),
    delete: async (k) => m.delete(k),
    incr: async (k, d = 1, o) => {
      const e = live(k);
      const n = ((e?.v as number | undefined) ?? 0) + d;
      m.set(k, { v: n, exp: e ? e.exp : o?.ttlSeconds ? now() + o.ttlSeconds * 1000 : null });
      return n;
    },
  };
  return { db, kv };
}

export interface TestApp extends App {
  deps: Deps;
  /** Advance the fake clock. */
  tick(ms: number): void;
  call(method: string, path: string, init?: { body?: unknown; headers?: Record<string, string> }): Promise<Response>;
}

export function testApp(overrides: Partial<Deps> = {}): TestApp {
  let t = 1_700_000_000_000;
  const now = () => t;
  const deps: Deps = { storage: memoryStorage(now), version: "test", now, config: testConfig(), hasher: fastHasher, rtctl: new FakeRtCtl(), ...overrides };
  const app = createApp(deps);
  return {
    ...app,
    deps,
    tick: (ms) => void (t += ms),
    call: (method, path, init = {}) => {
      const headers = new Headers(init.headers);
      let body: string | undefined;
      if (init.body !== undefined) {
        body = JSON.stringify(init.body);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      }
      return app.fetch(new Request(`http://localhost${path}`, { method, headers, ...(body ? { body } : {}) }));
    },
  };
}
