// Type stubs for the editor's TS worker. Source: runtime docs/handlers.md "std:sql".
declare module "std:sql" {
  export type SqlArg = null | undefined | boolean | number | bigint | string | Uint8Array;
  export type SqlArgs = SqlArg[] | Record<string, SqlArg>;
  export interface SqlResult {
    columns: string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rows: any[][];
    rowsAffected: number;
    lastInsertRowid: number | bigint | null;
  }
  export type SqlStatement = string | { sql: string; args?: SqlArgs };
  export interface SqlTx {
    execute(sql: string, args?: SqlArgs): Promise<SqlResult>;
  }
  export interface Sql extends SqlTx {
    batch(stmts: SqlStatement[], mode: "read" | "write"): Promise<SqlResult[]>;
    transaction<T>(fn: (tx: SqlTx) => Promise<T>): Promise<T>;
  }
  export const sql: Sql;
}
