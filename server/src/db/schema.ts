// Schema migrations for std:sql (design §6). Times are unix ms INTEGER; ids are `xxx_<ulid>` TEXT;
// booleans are INTEGER 0/1; sealed secrets are BLOB.
//
// Rules: append only. Each migration is idempotent (IF NOT EXISTS) so a partial
// earlier run can be re-applied, and every statement must be valid on both the
// runtime SQLite and node:sqlite (no ATTACH, no pragmas, no triggers needed).

export interface Migration {
  version: number;
  name: string;
  statements: readonly string[];
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "init",
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_version (v INTEGER PRIMARY KEY)`,
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        pw_hash TEXT NOT NULL,
        must_change INTEGER NOT NULL DEFAULT 0,
        instance_admin INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS identities (
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id),
        email TEXT,
        PRIMARY KEY (provider, subject)
      )`,
      `CREATE TABLE IF NOT EXISTS user_totp (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        secret_sealed BLOB NOT NULL,
        enabled_at INTEGER,
        last_step INTEGER NOT NULL DEFAULT -1
      )`,
      `CREATE TABLE IF NOT EXISTS recovery_codes (
        user_id TEXT NOT NULL REFERENCES users(id),
        code_hash TEXT NOT NULL,
        used_at INTEGER,
        PRIMARY KEY (user_id, code_hash)
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        csrf TEXT NOT NULL,
        mfa_pending INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ip TEXT,
        ua TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)`,
      `CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at)`,
      `CREATE TABLE IF NOT EXISTS login_events (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        ts INTEGER NOT NULL,
        ip TEXT,
        ua TEXT,
        method TEXT NOT NULL,
        ok INTEGER NOT NULL,
        email TEXT,
        result TEXT NOT NULL DEFAULT 'ok'
      )`,
      `CREATE INDEX IF NOT EXISTS login_events_user_ts ON login_events (user_id, ts)`,
      `CREATE TABLE IF NOT EXISTS orgs (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        tenant_id TEXT NOT NULL UNIQUE,
        default_key_id TEXT,
        default_key_sealed BLOB,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS members (
        org_id TEXT NOT NULL REFERENCES orgs(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (org_id, user_id)
      )`,
      `CREATE INDEX IF NOT EXISTS members_user ON members (user_id)`,
      `CREATE TABLE IF NOT EXISTS project_grants (
        org_id TEXT NOT NULL REFERENCES orgs(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        project TEXT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (org_id, user_id, project)
      )`,
      `CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        org_id TEXT REFERENCES orgs(id),
        email TEXT NOT NULL,
        role TEXT,
        instance_admin INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        accepted_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS tokens (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id),
        runtime_key_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        scopes TEXT NOT NULL,
        projects TEXT NOT NULL,
        envs TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS domains (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id),
        app_slug TEXT NOT NULL,
        host TEXT NOT NULL UNIQUE COLLATE NOCASE,
        txt_token TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        verified_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS audit (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        org_id TEXT,
        actor_id TEXT,
        action TEXT NOT NULL,
        target TEXT,
        data TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS audit_org_ts ON audit (org_id, ts)`,
      `CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts)`,
      `CREATE TABLE IF NOT EXISTS version_authors (
        org_id TEXT NOT NULL,
        app_slug TEXT NOT NULL,
        version TEXT NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (org_id, app_slug, version)
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS pending_key_revokes (
        runtime_key_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    // Domains need the runtime service id (host mapping), the project (authz), checker state,
    // and a pending runtime-unmap queue; audit needs the instance-admin flag. ALTERs are not
    // IF-NOT-EXISTS, so this migration relies on its batch being atomic and applied once.
    version: 2,
    name: "domains-checks-audit-flag",
    statements: [
      `ALTER TABLE domains ADD COLUMN project_slug TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE domains ADD COLUMN service_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE domains ADD COLUMN last_checked_at INTEGER`,
      `ALTER TABLE domains ADD COLUMN txt_misses INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE audit ADD COLUMN as_instance_admin INTEGER NOT NULL DEFAULT 0`,
      `CREATE TABLE IF NOT EXISTS pending_unmaps (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        service_id TEXT NOT NULL,
        host TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = migrations.reduce((max, m) => Math.max(max, m.version), 0);
