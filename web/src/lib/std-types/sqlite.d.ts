// Type stubs for the editor's TS worker. Source: runtime docs/handlers.md "std:sqlite" (also "bun:sqlite").
declare module "std:sqlite" {
  export type SQLiteValue = null | undefined | number | bigint | boolean | string | Uint8Array;
  export type Params = SQLiteValue[] | [Record<string, SQLiteValue>];
  export interface Changes {
    changes: number;
    lastInsertRowid: number | bigint;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class Statement<Row = any> {
    all(...params: Params): Row[];
    get(...params: Params): Row | null;
    values(...params: Params): SQLiteValue[][];
    run(...params: Params): Changes;
    iterate(...params: Params): IterableIterator<Row>;
    as<T>(cls: new (...args: never[]) => T): Statement<T>;
    readonly columnNames: string[];
    readonly paramsCount: number;
    finalize(): void;
    toString(): string;
  }
  type Tx<A extends unknown[], R> = ((...args: A) => R) & {
    deferred: (...args: A) => R;
    immediate: (...args: A) => R;
    exclusive: (...args: A) => R;
  };
  export class Database {
    constructor(options?: { strict?: boolean; safeIntegers?: boolean; readonly?: boolean });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query<Row = any>(sql: string): Statement<Row>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prepare<Row = any>(sql: string): Statement<Row>;
    run(sql: string, ...params: Params): Changes;
    exec(sql: string, ...params: Params): Changes;
    transaction<A extends unknown[], R>(fn: (...args: A) => R): Tx<A, R>;
    readonly inTransaction: boolean;
    close(): void;
  }
  export class SQLiteError extends Error {
    code: string;
    errno: number;
    byteOffset: number;
    rtCode: string;
  }
  export default Database;
}

declare module "bun:sqlite" {
  export * from "std:sqlite";
  export { default } from "std:sqlite";
}
