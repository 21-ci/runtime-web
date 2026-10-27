// One-time reseal of legacy sealed values, run from scheduled(). Values sealed before
// seal contexts existed carry no AAD; openCompat still opens them and reseals on read,
// but a value that is never read stays legacy. This pass reseals every one of them with
// its context (CAS on the old bytes), then records `crypto.legacy_resealed` in settings
// so later runs skip it. A pass with any failure is not recorded and runs again.
// TODO(next release): drop the no-AAD fallback in openCompat once this has run everywhere.

import type { Deps } from "../app.ts";
import { secretContext, secretKey, PROVIDERS } from "../auth/oauth.ts";
import { totpContext } from "../auth/totp.ts";
import { dbOf, sealerOf } from "../auth/types.ts";
import { defaultKeyContext } from "../orgs/orgs.ts";
import { base64url } from "./random.ts";
import { openCompat, type Sealer } from "./seal.ts";

export const RESEAL_DONE_KEY = "crypto.legacy_resealed";

export interface ResealResult {
  resealed: number;
  failed: number;
  skipped: boolean;
}

/** New bytes for a legacy blob, or null when it already opens under its context. */
async function upgrade(s: Sealer, old: Uint8Array, context: string): Promise<Uint8Array | null> {
  return (await openCompat(s, old, context)).resealed;
}

function unb64url(v: string): Uint8Array {
  const b = v.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(b + "=".repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

export async function resealLegacy(deps: Pick<Deps, "storage" | "config" | "now">): Promise<ResealResult> {
  const db = await dbOf(deps);
  if (await db.first("SELECT 1 AS x FROM settings WHERE key = ?", [RESEAL_DONE_KEY])) return { resealed: 0, failed: 0, skipped: true };
  const s = await sealerOf(deps);
  const out: ResealResult = { resealed: 0, failed: 0, skipped: false };
  const each = async (what: string, f: () => Promise<boolean>) => {
    try {
      if (await f()) out.resealed++;
    } catch (e) {
      out.failed++;
      console.error(`reseal: ${what} failed`, e instanceof Error ? e.message : String(e));
    }
  };

  const orgs = await db.all<{ id: string; default_key_sealed: Uint8Array }>(
    "SELECT id, default_key_sealed FROM orgs WHERE default_key_sealed IS NOT NULL",
  );
  for (const o of orgs) {
    await each(`org ${o.id}`, async () => {
      const old = new Uint8Array(o.default_key_sealed);
      const next = await upgrade(s, old, defaultKeyContext(o.id));
      if (!next) return false;
      await db.run("UPDATE orgs SET default_key_sealed = ? WHERE id = ? AND default_key_sealed = ?", [next, o.id, old]);
      return true;
    });
  }

  const totp = await db.all<{ user_id: string; secret_sealed: Uint8Array }>("SELECT user_id, secret_sealed FROM user_totp");
  for (const t of totp) {
    await each(`totp ${t.user_id}`, async () => {
      const old = new Uint8Array(t.secret_sealed);
      const next = await upgrade(s, old, totpContext(t.user_id));
      if (!next) return false;
      await db.run("UPDATE user_totp SET secret_sealed = ? WHERE user_id = ? AND secret_sealed = ?", [next, t.user_id, old]);
      return true;
    });
  }

  for (const id of PROVIDERS) {
    await each(`oauth ${id}`, async () => {
      const row = await db.first<{ value: string }>("SELECT value FROM settings WHERE key = ?", [secretKey(id)]);
      if (!row) return false;
      const sec = JSON.parse(row.value) as unknown;
      if (typeof sec !== "string") return false;
      const next = await upgrade(s, unb64url(sec), secretContext(id));
      if (!next) return false;
      await db.run("UPDATE settings SET value = ? WHERE key = ? AND value = ?", [JSON.stringify(base64url(next)), secretKey(id), row.value]);
      return true;
    });
  }

  if (out.failed === 0) {
    await db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING", [RESEAL_DONE_KEY, JSON.stringify(deps.now())]);
  }
  if (out.resealed > 0 || out.failed > 0) console.warn(`reseal: ${out.resealed} legacy values resealed, ${out.failed} failed`);
  return out;
}
