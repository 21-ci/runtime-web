// Type stubs for the editor's TS worker. Source: runtime docs/handlers.md "std:services".
declare module "std:services" {
  export function call(slug: string, request: Request | string, init?: RequestInit): Promise<Response>;
}
