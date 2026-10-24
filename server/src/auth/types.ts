// Shared auth types and helpers used by every auth module and by other feature
// tasks (users, orgs, admin) that need the signed-in caller.

import type { Deps } from "../app.ts";
import { createSealer, type Sealer } from "../crypto/seal.ts";
import { ensureMigrated } from "../db/migrate.ts";
import type { Db } from "../storage/types.ts";
import { argon2Hasher, type Hasher } from "./password.ts";

/** The slice of Deps the auth layer needs. */
export type AuthDeps = Pick<Deps, "storage" | "now" | "config" | "hasher" | "fetch">;

/** The authenticated user (ctx.state.user). */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  instanceAdmin: boolean;
  mustChangePassword: boolean;
  disabled: boolean;
  createdAt: number;
}

/** The live session of the request (ctx.state.session). `id` is the stored sha256 hex of the cookie. */
export interface Session {
  id: string;
  userId: string;
  csrf: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string;
  ua: string;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  pw_hash: string;
  must_change: number;
  instance_admin: number;
  disabled: number;
  created_at: number;
  [k: string]: unknown;
}

export function userFromRow(r: UserRow): SessionUser {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    instanceAdmin: Number(r.instance_admin) !== 0,
    mustChangePassword: Number(r.must_change) !== 0,
    disabled: Number(r.disabled) !== 0,
    createdAt: Number(r.created_at),
  };
}

/** Migrated database handle. Every auth entry point goes through this. */
export async function dbOf(deps: Pick<Deps, "storage">): Promise<Db> {
  await ensureMigrated(deps.storage.db);
  return deps.storage.db;
}

export const hasherOf = (deps: Pick<Deps, "hasher">): Hasher => deps.hasher ?? argon2Hasher;

const sealers = new WeakMap<Uint8Array, Promise<Sealer>>();

/** Sealer for config.sealKey, imported once per key. */
export function sealerOf(deps: Pick<Deps, "config">): Promise<Sealer> {
  const key = deps.config.sealKey;
  let s = sealers.get(key);
  if (!s) {
    s = createSealer(key);
    sealers.set(key, s);
  }
  return s;
}

export async function getUserById(db: Db, id: string): Promise<UserRow | null> {
  return db.first<UserRow>("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL", [id]);
}

export async function getUserByEmail(db: Db, email: string): Promise<UserRow | null> {
  return db.first<UserRow>("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL", [normalizeEmail(email)]);
}

export function normalizeEmail(e: string): string {
  return e.trim().toLowerCase();
}

/** api-web §2 `User`. */
export interface UserJson {
  id: string;
  email: string;
  name: string;
  instance_admin: boolean;
  must_change_password: boolean;
  disabled: boolean;
  totp_enabled: boolean;
  created_at: number;
}

export function userJson(u: SessionUser, totpEnabled: boolean): UserJson {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    instance_admin: u.instanceAdmin,
    must_change_password: u.mustChangePassword,
    disabled: u.disabled,
    totp_enabled: totpEnabled,
    created_at: u.createdAt,
  };
}
