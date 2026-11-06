// Instance-admin node views and actions (api-web §6: /api/admin/node/*).

import type { Deps } from "../app.ts";
import { authOf, requireSession } from "../auth/middleware.ts";
import { invalid } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { withRuntimeErrors } from "../runtime/errors.ts";
import { json, readJson } from "../http/json.ts";
import {
  backupStatus, createBackup, drainNode, listBackups, nodeCache, nodeConfig, nodeEvents, nodeScheduler, nodeSeries, nodeStats, nodeStatus, parseNodeConfig, runtimeVersion, setNodeConfig,
} from "../keys/node.ts";

export function registerAdminNode(r: Router, deps: Deps): void {
  const s = (h: Parameters<typeof requireSession>[1]) => requireSession(deps, withRuntimeErrors(h), { admin: true });

  r.get(
    "/api/admin/node/status",
    s(async () => json(await nodeStatus(deps))),
  );

  r.get(
    "/api/admin/node/config",
    s(async () => json(await nodeConfig(deps))),
  );

  r.put(
    "/api/admin/node/config",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const patch = parseNodeConfig(await readJson<unknown>(ctx.req));
      return json(await setNodeConfig(deps, { id: user.id, name: user.name }, patch));
    }),
  );

  r.get(
    "/api/admin/node/scheduler",
    s(async () => json(await nodeScheduler(deps))),
  );

  r.get(
    "/api/admin/node/cache",
    s(async () => json(await nodeCache(deps))),
  );

  r.get(
    "/api/admin/node/version",
    s(async () => json(await runtimeVersion(deps))),
  );

  r.get(
    "/api/admin/node/series",
    s(async (ctx) => json(await nodeSeries(deps, ctx.url.searchParams.get("range") ?? "1h"))),
  );

  r.get(
    "/api/admin/node/stats",
    s(async (ctx) => json(await nodeStats(deps, ctx.url.searchParams.get("cursor") ?? undefined))),
  );

  r.get(
    "/api/admin/node/events",
    s(async (ctx) => {
      const q = ctx.url.searchParams;
      return json(await nodeEvents(deps, { after: q.get("after"), kinds: q.get("kinds"), limit: q.get("limit") }));
    }),
  );

  // Backups: read and start only. Downloading or deleting one is the operator's, on the node (21ci backup …).
  r.get(
    "/api/admin/backups/status",
    s(async () => json(await backupStatus(deps))),
  );

  r.get(
    "/api/admin/backups",
    s(async (ctx) => json(await listBackups(deps, ctx.url.searchParams.get("cursor")))),
  );

  r.post(
    "/api/admin/backups",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      return json(await createBackup(deps, { id: user.id, name: user.name }), 202);
    }),
  );

  r.post(
    "/api/admin/node/drain",
    s(async (ctx) => {
      const { user } = authOf(ctx);
      const body = (await readJson<unknown>(ctx.req)) as { confirm?: unknown } | null;
      if (!body || typeof body !== "object" || body.confirm !== "drain") {
        throw invalid({ confirm: 'must be "drain"' });
      }
      const out = await drainNode(deps, { id: user.id, name: user.name });
      return json(out ?? {}, 202);
    }),
  );
}
