import { Router } from "./http/router.ts";
import type { Storage } from "./storage/types.ts";
import type { RtCtl } from "./runtime/types.ts";
import { registerHealth } from "./routes/health.ts";
import { registerSpa, type SpaDeps } from "./spa.ts";
import type { Config } from "./config.ts";
import type { Hasher } from "./auth/password.ts";
import { registerAuth } from "./routes/auth.ts";
import { registerDomains } from "./routes/domains.ts";
import { registerAudit } from "./routes/audit.ts";
import { registerSettings } from "./routes/settings.ts";
import { registerInternal } from "./routes/internal.ts";
import type { AppLookup, TxtLookup } from "./domains/types.ts";
import type { RouteInfo } from "./http/router.ts";

// Composition root, runtime-agnostic: main.ts passes runtime adapters, tests pass
// in-memory ones. Each feature task adds one `registerX(router, deps)` line here.

export interface Deps {
  storage: Storage;
  version: string;
  now: () => number;
  /** Control-API transport (sdk rtctl at runtime, FakeRtCtl in tests). */
  rtctl?: RtCtl;
  /** Embedded console (src/gen/assets.ts); absent in most unit tests. */
  spa?: SpaDeps;
  config: Config;
  /** Password hasher; defaults to argon2id with the Go parameters (tests pass a cheap one). */
  hasher?: Hasher;
  /** Outbound fetch for OAuth/OIDC; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** App slug → runtime service (apps task); domain routes answer 404 without it. */
  apps?: AppLookup;
  /** TXT lookups for domain verification; defaults to DNS-over-HTTPS. */
  txt?: TxtLookup;
}

export interface App {
  fetch(req: Request, info?: { clientIp?: string }): Promise<Response>;
  /** Registered routes (contract guard). */
  routes(): RouteInfo[];
}

export function createApp(deps: Deps): App {
  const router = new Router();
  registerHealth(router, deps);
  registerAuth(router, deps);
  registerDomains(router, deps);
  registerAudit(router, deps);
  registerSettings(router, deps);
  registerInternal(router, deps);
  registerSpa(router, deps); // keep last: installs the SPA fallback
  return {
    fetch: (req, info) =>
      router.handle(req, {
        basePath: req.headers.get("x-rt-base-path") ?? "",
        clientIp: info?.clientIp ?? req.headers.get("x-rt-client-ip") ?? undefined,
      }),
    routes: () => router.describe(),
  };
}
