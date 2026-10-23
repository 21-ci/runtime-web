// Type stubs for the editor's TS worker. Source: runtime docs/handlers.md "std:platform".
declare module "std:platform" {
  export interface Platform {
    fetch(binding: string, request: Request | string, init?: RequestInit): Promise<Response>;
  }
  export const platform: Platform;
}
