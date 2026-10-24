// Instance auth policy in the settings table (port of internal/auth/policy.go).
// Values are JSON booleans; a missing key is false.

import { conflict } from "../http/errors.ts";
import type { Db, Stmt } from "../storage/types.ts";

export const SETTING_REQUIRE_2FA = "auth.require_2fa";
export const SETTING_PASSWORD_LOGIN_DISABLED = "auth.password_login_disabled";

export interface Policy {
  require2fa: boolean;
  passwordLoginDisabled: boolean;
}

async function flag(db: Db, key: string): Promise<boolean> {
  const r = await db.first<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]);
  if (!r) return false;
  return r.value === "true" || r.value === "1" || r.value === '"1"';
}

export async function getPolicy(db: Db): Promise<Policy> {
  return {
    require2fa: await flag(db, SETTING_REQUIRE_2FA),
    passwordLoginDisabled: await flag(db, SETTING_PASSWORD_LOGIN_DISABLED),
  };
}

/** Statements that store p; run them in the caller's batch (with its audit row). */
export function policyStatements(p: Policy): Stmt[] {
  const up = "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
  return [
    { sql: up, args: [SETTING_REQUIRE_2FA, JSON.stringify(p.require2fa)] },
    { sql: up, args: [SETTING_PASSWORD_LOGIN_DISABLED, JSON.stringify(p.passwordLoginDisabled)] },
  ];
}

/**
 * Stores p plus `extra` statements atomically. Disabling password login without
 * a usable SSO provider is 409 sso_not_configured.
 */
export async function setPolicy(db: Db, p: Policy, ssoConfigured: boolean, extra: Stmt[] = []): Promise<void> {
  if (p.passwordLoginDisabled && !ssoConfigured) throw conflict("sso_not_configured", "configure a login provider first");
  await db.batch([...policyStatements(p), ...extra]);
}
