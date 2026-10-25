// Storage adapter interface. Feature code depends only on this; `runtime.ts`
// implements it on `std:sql` + `std:kv`, `memory.ts` on node:sqlite + a Map for
// unit tests. Keep the SQL dialect to what both SQLite builds accept.

export type SqlArg = null | boolean | number | bigint | string | Uint8Array;
export type Row = Record<string, unknown>;

export interface Stmt {
  sql: string;
  args?: SqlArg[];
}

export interface Tx {
  all<T extends Row = Row>(sql: string, args?: SqlArg[]): Promise<T[]>;
  run(sql: string, args?: SqlArg[]): Promise<{ changes: number; lastId: number | bigint | null }>;
}

export interface Db extends Tx {
  first<T extends Row = Row>(sql: string, args?: SqlArg[]): Promise<T | null>;
  /** All statements in one write transaction. */
  batch(stmts: Stmt[]): Promise<void>;
  /** Interactive transaction; the runtime caps it at 5 s. */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface Kv {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** Atomic counter; `ttlSeconds` applies only on create (fixed windows). */
  incr(key: string, delta?: number, opts?: { ttlSeconds?: number }): Promise<number>;
}

export interface Storage {
  db: Db;
  kv: Kv;
}
