// Ambient declarations for the runtime's std:* modules (runtime docs:
// reference/guest-api.md "Type declarations"). The runtime build ignores .d.ts.

declare module "std:kv" {
  type Ttl = { ttlSeconds?: number };
  export const kv: {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown, opts?: Ttl): Promise<void>;
    delete(key: string): Promise<boolean>;
    list<T = unknown>(opts?: { prefix?: string; cursor?: string | null; limit?: number }): Promise<{
      entries: { key: string; value: T }[];
      cursor: string | null;
    }>;
    incr(key: string, delta?: number, opts?: Ttl): Promise<number>;
  };
}

declare module "std:sql" {
  export type SqlArg = null | undefined | boolean | number | bigint | string | Uint8Array;
  export interface SqlResult {
    columns: string[];
    rows: unknown[][];
    rowsAffected: number;
    lastInsertRowid: number | bigint | null;
  }
  export type Statement = string | { sql: string; args?: SqlArg[] };
  export interface Tx {
    execute(sql: string, args?: SqlArg[]): Promise<SqlResult>;
  }
  export const sql: {
    execute(sql: string, args?: SqlArg[]): Promise<SqlResult>;
    batch(stmts: Statement[], mode?: "read" | "write"): Promise<SqlResult[]>;
    transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  };
}

declare module "std:blob" {
  export const blob: {
    put(key: string, body: string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>, opts?: { contentType?: string }): Promise<void>;
    get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number; contentType: string } | null>;
    head(key: string): Promise<{ size: number; contentType: string } | null>;
    delete(key: string): Promise<boolean>;
  };
}

declare module "std:sdk" {
  export class SdkError extends Error {
    code: string;
  }
  export function sdk(name: string): Record<string, (arg?: unknown) => Promise<unknown>>;
}

declare const Deno: { env: { get(name: string): string | undefined } };

interface RtCtx {
  taskId: string;
  service: { id: string; slug: string; version: number };
  trigger: string;
  client?: { ip: string };
  deadline: number;
  waitUntil(p: Promise<unknown>): void;
}
