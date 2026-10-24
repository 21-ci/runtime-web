// Sessions (port of internal/auth/session.go). The cookie holds 32 random bytes
// as hex; the row key is sha256(raw bytes) hex, so a DB dump cannot be replayed.
// Idle TTL 7 d (sliding, touched at most once a minute), absolute 30 d,
// MFA-pending sessions 5 min.

import { constantTimeEqual, hex, sha256Hex } from "../crypto/hash.ts";
import { randomBytes, randomHex } from "../crypto/random.ts";
import { clearCookie, getCookie, sessionCookieName, setCookie } from "../http/cookies.ts";
import { notFound } from "../http/errors.ts";
import type { Db } from "../storage/types.ts";
import { getUserById, userFromRow, type Session, type SessionUser } from "./types.ts";

export const IDLE_TTL_MS = 7 * 24 * 3600_000;
export const ABSOLUTE_TTL_MS = 30 * 24 * 3600_000;
export const MFA_PENDING_TTL_MS = 5 * 60_000;
const TOUCH_EVERY_MS = 60_000;
export const PUBLIC_ID_LEN = 12;

interface SessionRow {
  id_hash: string;
  user_id: string;
  csrf: string;
  mfa_pending: number;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ip: string | null;
  ua: string | null;
  [k: string]: unknown;
}

/** Stored id for a cookie value, or null if it is not 32 hex-encoded bytes. */
export async function hashCookie(v: string): Promise<string | null> {
  if (!/^[0-9a-fA-F]{64}$/.test(v)) return null;
  const raw = Uint8Array.from(v.match(/../g) ?? [], (h) => parseInt(h, 16));
  return sha256Hex(raw);
}

export interface Created {
  cookie: string;
  csrf: string;
  id: string;
}

/** Creates a full (pending=false) or MFA-pending session. Pending sessions have no usable CSRF. */
export async function createSession(
  db: Db,
  now: number,
  userId: string,
  ip: string,
  ua: string,
  pending = false,
): Promise<Created> {
  const cookie = hex(randomBytes(32));
  const csrf = randomHex(32);
  const id = (await hashCookie(cookie)) as string;
  const ttl = pending ? MFA_PENDING_TTL_MS : ABSOLUTE_TTL_MS;
  await db.run(
    `INSERT INTO sessions (id_hash, user_id, csrf, mfa_pending, created_at, last_seen_at, expires_at, ip, ua)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, csrf, pending ? 1 : 0, now, now, now + ttl, ip, ua],
  );
  return { cookie, csrf: pending ? "" : csrf, id };
}

function toSession(r: SessionRow, lastSeen = Number(r.last_seen_at)): Session {
  return {
    id: r.id_hash,
    userId: r.user_id,
    csrf: Number(r.mfa_pending) ? "" : r.csrf,
    createdAt: Number(r.created_at),
    lastSeenAt: lastSeen,
    expiresAt: Number(r.expires_at),
    ip: r.ip ?? "",
    ua: r.ua ?? "",
  };
}

export interface Lookup {
  session: Session;
  user: SessionUser;
}

/**
 * Resolves a cookie to a live session and user, sliding the idle window.
 * `pending` selects MFA-pending (true) or full (false) sessions; the other kind,
 * expired, deleted-user and disabled-user sessions are null.
 */
export async function lookupSession(db: Db, now: number, cookie: string, pending = false): Promise<Lookup | null> {
  const id = await hashCookie(cookie);
  if (!id) return null;
  const r = await db.first<SessionRow>("SELECT * FROM sessions WHERE id_hash = ?", [id]);
  if (!r) return null;
  const last = Number(r.last_seen_at);
  if (now >= Number(r.expires_at) || (!pending && now - last >= IDLE_TTL_MS)) {
    await db.run("DELETE FROM sessions WHERE id_hash = ?", [id]);
    return null;
  }
  if (Boolean(Number(r.mfa_pending)) !== pending) return null;
  const u = await getUserById(db, r.user_id);
  if (!u || Number(u.disabled)) return null;
  let seen = last;
  if (!pending && now - last >= TOUCH_EVERY_MS) {
    await db.run("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?", [now, id]);
    seen = now;
  }
  return { session: toSession(r, seen), user: userFromRow(u) };
}

/** Deletes one session by stored id; returns whether a row was removed. */
export async function revokeSession(db: Db, id: string): Promise<boolean> {
  return (await db.run("DELETE FROM sessions WHERE id_hash = ?", [id])).changes > 0;
}

/** Deletes every session of userId except `exceptId` (empty: all). Returns the count. */
export async function revokeAllForUser(db: Db, userId: string, exceptId = ""): Promise<number> {
  return (await db.run("DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?", [userId, exceptId])).changes;
}

export interface SessionInfo {
  id: string;
  ip: string;
  ua: string;
  created_at: number;
  last_seen_at: number;
  current: boolean;
}

/** Live full sessions of userId, newest first; MFA-pending ones are omitted. */
export async function listSessions(db: Db, now: number, userId: string, currentId: string): Promise<SessionInfo[]> {
  const rows = await db.all<SessionRow>(
    "SELECT * FROM sessions WHERE user_id = ? AND mfa_pending = 0 ORDER BY created_at DESC",
    [userId],
  );
  return rows
    .filter((r) => now < Number(r.expires_at) && now - Number(r.last_seen_at) < IDLE_TTL_MS)
    .map((r) => ({
      id: r.id_hash.slice(0, PUBLIC_ID_LEN),
      ip: r.ip ?? "",
      ua: r.ua ?? "",
      created_at: Number(r.created_at),
      last_seen_at: Number(r.last_seen_at),
      current: r.id_hash === currentId,
    }));
}

/** Revokes one of userId's sessions by public id; anything else is 404 not_found. */
export async function revokeByPublicId(db: Db, userId: string, publicId: string): Promise<void> {
  const pid = publicId.toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(pid)) throw notFound();
  const rows = await db.all<{ id_hash: string }>("SELECT id_hash FROM sessions WHERE user_id = ?", [userId]);
  const hit = rows.find((r) => constantTimeEqual(r.id_hash.slice(0, PUBLIC_ID_LEN), pid));
  if (!hit) throw notFound();
  await revokeSession(db, hit.id_hash);
}

export interface CookieCfg {
  insecureCookies: boolean;
}

export const sessionCookie = (cfg: CookieCfg, req: Request): string | undefined =>
  getCookie(req, sessionCookieName({ insecure: cfg.insecureCookies }));

export const setSessionCookie = (cfg: CookieCfg, value: string): string =>
  setCookie(sessionCookieName({ insecure: cfg.insecureCookies }), value, {
    insecure: cfg.insecureCookies,
    maxAgeSeconds: ABSOLUTE_TTL_MS / 1000,
  });

export const clearSessionCookie = (cfg: CookieCfg): string =>
  clearCookie(sessionCookieName({ insecure: cfg.insecureCookies }), { insecure: cfg.insecureCookies });
