// Ambient declarations the editor's TS worker loads next to the std:* stubs (handlers.md "Imports").
// Build-resolved specifiers are typed as any; the build reports real errors.
declare module "npm:*";
declare module "jsr:*";
declare module "https://*";
declare module "sdk:*";

declare namespace Deno {
  const env: {
    get(name: string): string | undefined;
    has(name: string): boolean;
    toObject(): Record<string, string>;
    set(name: string, value: string): never;
    delete(name: string): never;
  };
}
