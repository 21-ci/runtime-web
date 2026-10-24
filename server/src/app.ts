import { Router } from "./http/router.ts";
import type { Storage } from "./storage/types.ts";
import { registerHealth } from "./routes/health.ts";

// Composition root, runtime-agnostic: main.ts passes runtime adapters, tests pass
// in-memory ones. Each feature task adds one `registerX(router, deps)` line here.

export interface Deps {
  storage: Storage;
  version: string;
  now: () => number;
}

export interface App {
  fetch(req: Request, info?: { clientIp?: string }): Promise<Response>;
}

export function createApp(deps: Deps): App {
  const router = new Router();
  registerHealth(router, deps);
  return {
    fetch: (req, info) =>
      router.handle(req, {
        basePath: req.headers.get("x-rt-base-path") ?? "",
        clientIp: info?.clientIp ?? req.headers.get("x-rt-client-ip") ?? undefined,
      }),
  };
}
