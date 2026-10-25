import { createApp, type Deps } from "./app.ts";
import { blob } from "std:blob";
import { sdk } from "std:sdk";
import { assets } from "./gen/assets.ts";
import { runtimeStorage } from "./storage/runtime.ts";
import { loadConfig } from "./config.ts";
import { scheduled } from "./jobs.ts";
import { argon2Hasher } from "./auth/password.ts";
import { sdkRtCtl } from "./runtime/client.ts";
import { appLookup } from "./apps/service.ts";

// Runtime entry (rt.json "entry"). Form B handler: `fetch` for HTTP, `scheduled`
// for the housekeeping cron (expiry, key-revoke and domain retries: src/jobs.ts).
// loadConfig throws ConfigError on a bad env, so a misconfigured deploy fails at load.

const deps: Deps = {
  storage: runtimeStorage(),
  version: Deno.env.get("RTWEB_VERSION") ?? "dev",
  now: () => Date.now(),
  spa: { assets, blobs: blob, assetToken: () => Deno.env.get("RTWEB_ASSET_TOKEN") },
  config: loadConfig((n) => Deno.env.get(n)),
  hasher: argon2Hasher,
  rtctl: sdkRtCtl(sdk("rtctl")),
};
deps.apps = appLookup(deps);
const app = createApp(deps);

export default {
  fetch(req: Request, ctx: RtCtx): Promise<Response> {
    return app.fetch(req, ctx.client ? { clientIp: ctx.client.ip } : {});
  },
  scheduled(): Promise<void> {
    return scheduled(deps);
  },
};
