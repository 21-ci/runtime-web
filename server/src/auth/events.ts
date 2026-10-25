// Login history, table login_events.

import { newId } from "../crypto/random.ts";
import type { Db } from "../storage/types.ts";

export type LoginMethod = "password" | "oauth" | "invite";
export type LoginResult = "ok" | "bad_password" | "bad_totp" | "rate_limited" | "disabled" | "sso_only" | "mfa_pending";

export interface LoginEventIn {
  userId: string;
  email: string;
  ip: string;
  ua: string;
  method: LoginMethod;
  result: LoginResult;
}

export async function recordLogin(db: Db, now: number, ev: LoginEventIn): Promise<void> {
  await db.run(
    "INSERT INTO login_events (id, user_id, ts, ip, ua, method, ok, email, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [newId("lev", now), ev.userId || null, now, ev.ip, ev.ua, ev.method, ev.result === "ok" ? 1 : 0, ev.email, ev.result],
  );
}

/** api-web §5.1 LoginEvent. */
export interface LoginEventJson {
  id: string;
  at: number;
  ip: string;
  ua: string;
  method: LoginMethod;
  result: LoginResult;
}

export async function listLogins(db: Db, userId: string, limit: number): Promise<LoginEventJson[]> {
  const rows = await db.all<{ id: string; ts: number; ip: string | null; ua: string | null; method: string; result: string }>(
    "SELECT id, ts, ip, ua, method, result FROM login_events WHERE user_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?",
    [userId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    at: Number(r.ts),
    ip: r.ip ?? "",
    ua: r.ua ?? "",
    method: r.method as LoginMethod,
    result: r.result as LoginResult,
  }));
}
