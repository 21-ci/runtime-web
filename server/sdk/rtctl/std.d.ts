// Ambient declarations for the operator-only std modules (runtime docs:
// reference/guest-api.md). std:kv and Deno come from src/rt.d.ts.
declare module "std:sdk/server" {
  export function defineSdk(def: {
    methods: Record<string, (args: never, ctx: never) => Promise<unknown>>;
    authorize?: (caller: unknown, method: string, args: unknown) => unknown;
  }): unknown;
}
declare module "std:platform" {
  export const platform: {
    fetch(binding: string, request: Request | string | URL, init?: RequestInit): Promise<Response>;
  };
}
