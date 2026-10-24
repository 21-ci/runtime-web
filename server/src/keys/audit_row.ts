// Audit row writer for T6 mutations. The `audit` table is owned by T8; this
// writes the same columns so rows land in the same log. Callers pass the row
// through `db.tx` together with the change it describes.

import { newId } from "../crypto/random.ts";
import type { Tx } from "../storage/types.ts";

export interface AuditEntry {
  orgId: string | null;
  actorId: string | null;
  action: string;
  target: string | null;
  data?: Record<string, unknown>;
}

export async function writeAudit(tx: Tx, now: number, e: AuditEntry): Promise<void> {
  await tx.run("INSERT INTO audit (id, ts, org_id, actor_id, action, target, data) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    newId("aud_", now),
    now,
    e.orgId,
    e.actorId,
    e.action,
    e.target,
    JSON.stringify(e.data ?? {}),
  ]);
}
