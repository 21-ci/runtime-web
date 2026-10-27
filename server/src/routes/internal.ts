// Internal routes for the edge (design D10). Caddy on-demand TLS asks whether it may
// issue a certificate for a host: 200 only for an active custom domain or for
// <slug>.<apps host> when an App with that slug exists, else 404.
// Loopback clients only (runtime-resolved client IP); anyone else gets 404.

import type { Deps } from "../app.ts";
import { dbOf } from "../auth/types.ts";
import { normalizeHost } from "../domains/domains.ts";
import type { Router } from "../http/router.ts";
import { notFound } from "../http/errors.ts";
import { loopbackOnly } from "../http/loopback.ts";
import { appIndexGet } from "../apps/index-table.ts";
import type { Db } from "../storage/types.ts";

export function registerInternal(r: Router, deps: Deps): void {
  r.get("/api/internal/tls-ask", loopbackOnly(async (ctx) => {
    const raw = ctx.url.searchParams.get("domain") ?? "";
    let host: string;
    try {
      host = normalizeHost(raw, "");
    } catch {
      throw notFound();
    }
    const db = await dbOf(deps);
    const row = await db.first<{ id: string }>(
      "SELECT id FROM domains WHERE host = ? AND status = 'active'",
      [host],
    );
    if (!row && !(await isAppHost(deps, db, host))) throw notFound();
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }));
}

/** True when host is <slug>.<apps host> of an App in a live org: one indexed lookup, no runtime call. */
async function isAppHost(deps: Deps, db: Db, host: string): Promise<boolean> {
  const base = deps.config.runtimePublicUrl;
  if (!base) return false;
  const suffix = `.${new URL(base).hostname}`;
  if (!host.endsWith(suffix)) return false;
  return (await appIndexGet(db, host.slice(0, -suffix.length))) !== null;
}
