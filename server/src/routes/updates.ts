// Instance-admin view of available releases, the toggle for the check, and whether the node sends telemetry.

import type { Deps } from "../app.ts";
import { auditStmt } from "../audit/audit.ts";
import { authOf, requireAdmin } from "../auth/middleware.ts";
import { dbOf } from "../auth/types.ts";
import { invalid } from "../http/errors.ts";
import { json, readJson } from "../http/json.ts";
import type { Router } from "../http/router.ts";
import { telemetryView } from "../telemetry/telemetry.ts";
import { checkNow, setEnabledStmts, updatesView } from "../updates/updates.ts";

export function registerUpdates(r: Router, deps: Deps): void {
  r.get(
    "/api/admin/updates",
    requireAdmin(deps, async () => json(await updatesView(deps))),
  );

  r.put(
    "/api/admin/updates",
    requireAdmin(deps, async (ctx) => {
      const { enabled } = await readJson<{ enabled?: unknown }>(ctx.req);
      if (typeof enabled !== "boolean") throw invalid({ enabled: "must_be_boolean" });
      const db = await dbOf(deps);
      await db.batch([
        ...setEnabledStmts(enabled),
        auditStmt(deps, {
          actor: { userId: authOf(ctx).user.id, asInstanceAdmin: true },
          action: "updates.configure",
          target: "instance",
          detail: { enabled },
        }),
      ]);
      return json(await updatesView(deps));
    }),
  );

  r.post(
    "/api/admin/updates/check",
    requireAdmin(deps, async () => {
      await checkNow(deps);
      return json(await updatesView(deps));
    }),
  );

  r.get(
    "/api/admin/telemetry",
    requireAdmin(deps, async () => json(await telemetryView(deps))),
  );
}
