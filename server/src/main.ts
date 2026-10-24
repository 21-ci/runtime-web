import { createApp } from "./app.ts";
import { runtimeStorage } from "./storage/runtime.ts";
import { loadConfig } from "./config.ts";

// Runtime entry (rt.json "entry"). Form B handler: `fetch` for HTTP, `scheduled`
// for the housekeeping cron (session/invite expiry, domain re-verify: later tasks).

const app = createApp({
  storage: runtimeStorage(),
  version: Deno.env.get("RTWEB_VERSION") ?? "dev",
  now: () => Date.now(),
  config: loadConfig((n) => Deno.env.get(n)),
});

export default {
  fetch(req: Request, ctx: RtCtx): Promise<Response> {
    return app.fetch(req, ctx.client ? { clientIp: ctx.client.ip } : {});
  },
  scheduled(): void {
    // housekeeping lands with task T7 (docs/design/backend-on-runtime.md)
  },
};
