// Type stubs for the editor's TS worker. Source: runtime docs/handlers.md "std:kv".
declare module "std:kv" {
  export type KvValue = unknown;
  export interface KvEntry {
    key: string;
    value: KvValue;
  }
  export interface Kv {
    get(key: string): Promise<KvValue | null>;
    getMany(keys: string[]): Promise<(KvValue | null)[]>;
    set(key: string, value: KvValue, options?: { ttlSeconds?: number }): Promise<void>;
    delete(key: string): Promise<boolean>;
    list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
      entries: KvEntry[];
      cursor: string | null;
    }>;
    incr(key: string, delta?: number, options?: { ttlSeconds?: number }): Promise<number>;
    incr(key: string, delta: bigint, options?: { ttlSeconds?: number }): Promise<bigint>;
  }
  export const kv: Kv;
}
