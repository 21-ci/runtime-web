import { Router } from "./http/router.ts";
import type { Storage } from "./storage/types.ts";
import type { RtCtl } from "./runtime/types.ts";
import { registerHealth } from "./routes/health.ts";
import { registerSpa, type SpaDeps } from "./spa.ts";
import type { Config } from "./config.ts";
import type { Hasher } from "./auth/password.ts";
import { registerAuth } from "./routes/auth.ts";
import { registerOrgs } from "./routes/orgs.ts";
import { registerAdminUsers } from "./routes/admin_users.ts";
import { registerInvites } from "./routes/invites.ts";
import { registerTokens } from "./routes/tokens.ts";
import { registerProjects } from "./routes/projects.ts";
import { registerLimitsUsage } from "./routes/limits_usage.ts";
import { registerAdminNode } from "./routes/admin_node.ts";
import { registerApps } from "./routes/apps.ts";
import { registerDomains } from "./routes/domains.ts";
import { registerAudit } from "./routes/audit.ts";
import { registerSettings } from "./routes/settings.ts";
import { registerBranding } from "./routes/branding.ts";
import { registerInternal } from "./routes/internal.ts";
import type { AppLookup, TxtLookup } from "./domains/types.ts";
import { appLookup } from "./apps/service.ts";
import type { RouteInfo } from "./http/router.ts";
import { withSecurityHeaders } from "./http/security.ts";

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
  deps.apps ??= appLookup(deps);
  const router = new Router();
  registerHealth(router, deps);
  registerAuth(router, deps);
  registerOrgs(router, deps);
  registerAdminUsers(router, deps);
  registerInvites(router, deps);
  registerTokens(router, deps);
  registerProjects(router, deps);
  registerLimitsUsage(router, deps);
  registerAdminNode(router, deps);
  registerApps(router, deps);
  registerDomains(router, deps);
  registerAudit(router, deps);
  registerSettings(router, deps);
  registerBranding(router, deps);
  registerInternal(router, deps);
  registerSpa(router, deps); // keep last: installs the SPA fallback
  const appOrigin = appFrameSources(deps.config.runtimePublicUrl);
  return {
    fetch: async (req, info) =>
      withSecurityHeaders(
        await router.handle(req, {
          basePath: req.headers.get("x-rt-base-path") ?? "",
          // The runtime-resolved address only (ctx.client.ip, else its x-rt-client-ip, which
          // clients cannot set). X-Forwarded-For is never consulted.
          clientIp: info?.clientIp ?? req.headers.get("x-rt-client-ip") ?? undefined,
        }),
        deps.config.origin,
        appOrigin,
      ),
    routes: () => router.describe(),
  };
}

/** CSP frame-src for the App preview: every App subdomain of the apps origin. */
export function appFrameSources(runtimePublicUrl: string): string | undefined {
  if (!runtimePublicUrl) return undefined;
  const u = new URL(runtimePublicUrl);
  return `${u.protocol}//*.${u.host}`;
}
