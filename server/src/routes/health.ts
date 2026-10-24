import type { Deps } from "../app.ts";
import type { Router } from "../http/router.ts";
import { json } from "../http/json.ts";

// GET /healthz is the contract route (api-web.md §2); /api/healthz is the same
// answer under /api for probes that only reach the API prefix. `db` proves the
// storage adapter works end to end.
export function registerHealth(r: Router, deps: Deps): void {
  const h = async () => {
    const row = await deps.storage.db.first<{ ok: number }>("SELECT 1 AS ok");
    return json({ ok: true, db: row?.ok === 1, version: deps.version });
  };
  r.get("/healthz", h);
  r.get("/api/healthz", h);
}
