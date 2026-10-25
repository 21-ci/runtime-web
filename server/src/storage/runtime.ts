import { sql, type SqlResult } from "std:sql";
import { kv } from "std:kv";
import type { Db, Kv, Row, SqlArg, Storage, Tx } from "./types.ts";

// std:sql/std:kv adapter. Only imported from main.ts (the runtime entry), never
// from unit tests, because `std:*` modules exist only inside the runtime.

function rows<T extends Row>(r: SqlResult): T[] {
  return r.rows.map((vals) => {
    const o: Row = {};
    r.columns.forEach((c, i) => (o[c] = vals[i]));
    return o as T;
  });
}

function txOf(exec: (q: string, a?: SqlArg[]) => Promise<SqlResult>): Tx {
  return {
    all: async (q, a) => rows(await exec(q, a)),
    run: async (q, a) => {
      const r = await exec(q, a);
      return { changes: r.rowsAffected, lastId: r.lastInsertRowid };
    },
  };
}

export function runtimeStorage(): Storage {
  const base = txOf((q, a) => sql.execute(q, a));
  const db: Db = {
    ...base,
    first: async <T extends Row>(q: string, a?: SqlArg[]) => (await base.all<T>(q, a))[0] ?? null,
    batch: async (stmts) => {
      await sql.batch(stmts.map((s) => ({ sql: s.sql, args: s.args ?? [] })), "write");
    },
    tx: (fn) => sql.transaction((t) => fn(txOf((q, a) => t.execute(q, a)))),
  };
  const store: Kv = {
    get: (k) => kv.get(k),
    set: (k, v, o) => kv.set(k, v, o),
    delete: (k) => kv.delete(k),
    incr: (k, d, o) => kv.incr(k, d ?? 1, o),
  };
  return { db, kv: store };
}
