// Type stubs for the editor's TS worker. Source: runtime docs/handlers.md "std:queue".
declare module "std:queue" {
  export function enqueue(
    service: string,
    body: unknown,
    options?: { delaySeconds?: number; dedupId?: string },
  ): Promise<{ id: string }>;
}
