// Internal routes for the edge (design D10). Caddy on-demand TLS asks whether it may
// issue a certificate for a host: 200 only for an active custom domain, else 404.
// Reachable only from localhost (enforced by the Caddy site, not here).

import type { Deps } from "../app.ts";
import { dbOf } from "../auth/types.ts";
import { normalizeHost } from "../domains/domains.ts";
import type { Router } from "../http/router.ts";
import { notFound } from "../http/errors.ts";

export function registerInternal(r: Router, deps: Deps): void {
  r.get("/api/internal/tls-ask", async (ctx) => {
    const raw = ctx.url.searchParams.get("domain") ?? "";
    let host: string;
    try {
      host = normalizeHost(raw, "");
    } catch {
      throw notFound();
    }
    const row = await (await dbOf(deps)).first<{ id: string }>(
      "SELECT id FROM domains WHERE host = ? AND status = 'active'",
      [host],
    );
    if (!row) throw notFound();
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  });
}
