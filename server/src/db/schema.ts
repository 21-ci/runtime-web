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
  {
    // Instance branding images (logos, icon). Text fields live in settings under "branding";
    // images are base64 TEXT so both SQLite builds round-trip them without BLOB quirks.
    version: 3,
    name: "branding-assets",
    statements: [
      `CREATE TABLE IF NOT EXISTS branding_assets (
        kind TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        data TEXT NOT NULL,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    // Bearer tokens on the console API: sha256 hex of each custom token's secret, set at mint.
    // Tokens minted before this version have none and cannot call the console API.
    version: 4,
    name: "token-secret-hash",
    statements: [
      `ALTER TABLE tokens ADD COLUMN secret_hash TEXT`,
      `CREATE UNIQUE INDEX IF NOT EXISTS tokens_secret_hash ON tokens (secret_hash)`,
    ],
  },
  {
    // Runtime services left behind by a failed app create (the template upload failed and so did the
    // cleanup delete). scheduled() retries the delete with backoff so the slug is freed.
    version: 5,
    name: "pending-service-deletes",
    statements: [
      `CREATE TABLE IF NOT EXISTS pending_service_deletes (
        service_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    // One row per background job: when it is next due, and where it stopped if the tick ran out.
    version: 6,
    name: "job-state",
    statements: [
      `CREATE TABLE IF NOT EXISTS job_state (
        name TEXT PRIMARY KEY,
        next_at INTEGER NOT NULL,
        cursor TEXT,
        last_ok_at INTEGER,
        last_error TEXT,
        failures INTEGER NOT NULL DEFAULT 0
      )`,
    ],
  },
  {
    // Time series as a fixed-slot ring: slot = step index % retention slots, ts in unix ms.
    version: 7,
    name: "metric-rollups",
    statements: [
      `CREATE TABLE IF NOT EXISTS metric_rollups (
        scope TEXT NOT NULL,
        step_s INTEGER NOT NULL,
        slot INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (scope, step_s, slot)
      ) WITHOUT ROWID`,
    ],
  },
  {
    // Git deploys. A delivery row is keyed by ref too: one commit pushed to two branches is two deployments.
    // git_refs holds what each ref last deployed, which outlives the 30-day delivery retention.
    version: 8,
    name: "git-links",
    statements: [
      `CREATE TABLE IF NOT EXISTS git_links (
        app_id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('github','gitlab','gitea')),
        base_url TEXT NOT NULL,
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        subdir TEXT,
        auto_promote INTEGER NOT NULL DEFAULT 1,
        paused INTEGER NOT NULL DEFAULT 0,
        hook_id TEXT NOT NULL UNIQUE,
        hook_secret_sealed BLOB NOT NULL,
        token_sealed BLOB,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS git_links_org ON git_links (org_id)`,
      `CREATE TABLE IF NOT EXISTS git_branch_rules (
        link_id TEXT NOT NULL,
        ref_pattern TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        auto_switch INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (link_id, ref_pattern)
      )`,
      `CREATE TABLE IF NOT EXISTS git_deliveries (
        hook_id TEXT NOT NULL,
        event TEXT NOT NULL,
        ref TEXT NOT NULL,
        sha TEXT NOT NULL,
        delivery_id TEXT,
        state TEXT NOT NULL,
        version INTEGER,
        error TEXT,
        received_at INTEGER NOT NULL,
        next_at INTEGER,
        head_sha TEXT,
        target_id TEXT,
        target_branch TEXT,
        activate INTEGER NOT NULL DEFAULT 0,
        fork INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        deployed_at INTEGER,
        PRIMARY KEY (hook_id, event, ref, sha)
      )`,
      `CREATE INDEX IF NOT EXISTS git_deliveries_due ON git_deliveries (state, next_at)`,
      `CREATE INDEX IF NOT EXISTS git_deliveries_received ON git_deliveries (received_at)`,
      `CREATE TABLE IF NOT EXISTS git_refs (
        hook_id TEXT NOT NULL,
        ref TEXT NOT NULL,
        sha TEXT NOT NULL,
        deployed_at INTEGER NOT NULL,
        PRIMARY KEY (hook_id, ref)
      )`,
    ],
  },
  {
    version: 9,
    name: "alerts",
    statements: [
      `CREATE TABLE IF NOT EXISTS alert_channels (
        id TEXT PRIMARY KEY,
        org_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('webhook','email','telegram')),
        name TEXT NOT NULL,
        config_sealed BLOB NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_ok_at INTEGER,
        last_error TEXT,
        test_window_at INTEGER,
        test_count INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS alert_channels_org ON alert_channels (org_id)`,
      `CREATE TABLE IF NOT EXISTS alert_rules (
        id TEXT PRIMARY KEY,
        org_id TEXT,
        app_id TEXT,
        kind TEXT NOT NULL,
        params TEXT NOT NULL,
        channels TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        for_s INTEGER NOT NULL DEFAULT 300,
        repeat_s INTEGER NOT NULL DEFAULT 14400,
        muted_until INTEGER,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS alert_rules_org ON alert_rules (org_id)`,
      `CREATE TABLE IF NOT EXISTS alert_state (
        rule_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('ok','pending','firing')),
        since INTEGER NOT NULL,
        last_sent_at INTEGER,
        last_value REAL,
        baseline_at INTEGER,
        clear_since INTEGER,
        seen_pass INTEGER,
        PRIMARY KEY (rule_id, subject)
      )`,
      `CREATE TABLE IF NOT EXISTS alert_outbox (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        org_id TEXT,
        rule_id TEXT,
        body TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS alert_outbox_due ON alert_outbox (next_at)`,
    ],
  },
  {
    version: 10,
    name: "previews_and_data_key",
    statements: [
      // Keyed by PR number: a fork's branch named like an internal one cannot reach that one's preview.
      // A held preview has no service yet: service_id and slug hold a placeholder until it is approved.
      `CREATE TABLE IF NOT EXISTS previews (
        service_id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        ref TEXT NOT NULL,
        pr INTEGER NOT NULL,
        sha TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        head_repo_id INTEGER,
        fork INTEGER NOT NULL DEFAULT 0,
        held INTEGER NOT NULL DEFAULT 0,
        approved_sha TEXT,
        approved_with_env INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_deploy_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        UNIQUE (app_id, pr)
      )`,
      `CREATE INDEX IF NOT EXISTS previews_due ON previews (expires_at)`,
      `CREATE TABLE IF NOT EXISTS preview_env (
        app_id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        env_sealed BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `ALTER TABLE git_links ADD COLUMN previews INTEGER NOT NULL DEFAULT 0`,
      // The repository's numeric id, set by the first signed event: a name can be renamed and taken over.
      `ALTER TABLE git_links ADD COLUMN repo_id INTEGER`,
      // A key holding only data:read, minted on first use. The default key never gets that scope.
      `ALTER TABLE orgs ADD COLUMN data_key_id TEXT`,
      `ALTER TABLE orgs ADD COLUMN data_key_sealed BLOB`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = migrations.reduce((max, m) => Math.max(max, m.version), 0);
