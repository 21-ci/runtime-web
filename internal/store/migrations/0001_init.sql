-- +goose Up

CREATE TABLE users (
    id                   TEXT PRIMARY KEY,
    email                TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name                 TEXT NOT NULL,
    password_hash       TEXT NOT NULL DEFAULT '',
    must_change_password INTEGER NOT NULL DEFAULT 0,
    is_instance_admin    INTEGER NOT NULL DEFAULT 0,
    disabled             INTEGER NOT NULL DEFAULT 0,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
);

CREATE TABLE identities (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider   TEXT NOT NULL,
    subject    TEXT NOT NULL,
    email      TEXT NOT NULL DEFAULT '',
    UNIQUE (provider, subject)
);

CREATE TABLE sessions (
    id_hash      TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf         TEXT NOT NULL,
    mfa_pending  INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    ip           TEXT NOT NULL DEFAULT '',
    user_agent   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE user_totp (
    user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_sealed  BLOB NOT NULL,
    enabled_at     INTEGER,
    last_used_step INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE recovery_codes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hash    TEXT NOT NULL,
    used_at INTEGER,
    PRIMARY KEY (user_id, hash)
);

CREATE TABLE login_events (
    id      TEXT PRIMARY KEY,
    at      INTEGER NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    email   TEXT NOT NULL DEFAULT '',
    ip      TEXT NOT NULL DEFAULT '',
    ua      TEXT NOT NULL DEFAULT '',
    method  TEXT NOT NULL CHECK (method IN ('password', 'oauth', 'invite')),
    result  TEXT NOT NULL CHECK (result IN ('ok', 'bad_password', 'bad_totp', 'rate_limited', 'disabled', 'sso_only'))
);

CREATE TABLE login_failures (
    ip    TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    at    INTEGER NOT NULL
);

CREATE TABLE invites (
    id         TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    org_id     TEXT REFERENCES orgs(id) ON DELETE CASCADE,
    role       TEXT CHECK (role IN ('owner', 'admin', 'member')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER,
    revoked_at INTEGER,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
);

CREATE TABLE version_authors (
    org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    service_id TEXT NOT NULL,
    version    INTEGER NOT NULL,
    user_id    TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (service_id, version)
);

CREATE TABLE orgs (
    id                 TEXT PRIMARY KEY,
    slug               TEXT NOT NULL UNIQUE,
    name               TEXT NOT NULL,
    tenant_id          TEXT NOT NULL UNIQUE,
    default_key_id     TEXT NOT NULL DEFAULT '',
    default_key_sealed BLOB,
    created_at         INTEGER NOT NULL
);

CREATE TABLE pending_key_revokes (
    key_id     TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE members (
    org_id  TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role    TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    PRIMARY KEY (org_id, user_id)
);

CREATE TABLE project_grants (
    org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_slug TEXT NOT NULL,
    role         TEXT NOT NULL CHECK (role IN ('admin', 'developer', 'viewer')),
    PRIMARY KEY (org_id, user_id, project_slug)
);

CREATE TABLE tokens (
    id             TEXT PRIMARY KEY,
    org_id         TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    runtime_key_id TEXT NOT NULL,
    name           TEXT NOT NULL,
    scopes         TEXT NOT NULL DEFAULT '[]',
    expires_at     INTEGER,
    created_by     TEXT NOT NULL REFERENCES users(id),
    created_at     INTEGER NOT NULL,
    revoked_at     INTEGER
);

CREATE TABLE domains (
    id              TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    project_slug    TEXT NOT NULL,
    service_id      TEXT NOT NULL,
    host            TEXT NOT NULL,
    token           TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('pending', 'active', 'failed')),
    last_checked_at INTEGER,
    verified_at     INTEGER,
    txt_misses      INTEGER NOT NULL DEFAULT 0,
    cert_status     TEXT NOT NULL DEFAULT 'none' CHECK (cert_status IN ('none', 'pending', 'issued', 'error')),
    cert_not_after  INTEGER,
    cert_error      TEXT,
    created_at      INTEGER NOT NULL,
    UNIQUE (org_id, host)
);

CREATE UNIQUE INDEX domains_active_host ON domains(host) WHERE status = 'active';

CREATE TABLE audit (
    id                TEXT PRIMARY KEY,
    at                INTEGER NOT NULL,
    actor_user_id     TEXT,
    as_instance_admin INTEGER NOT NULL DEFAULT 0,
    org_id            TEXT,
    action            TEXT NOT NULL,
    target            TEXT NOT NULL DEFAULT '',
    detail            TEXT NOT NULL DEFAULT ''
);

CREATE TABLE settings (
    key    TEXT PRIMARY KEY,
    value  BLOB NOT NULL,
    sealed INTEGER NOT NULL DEFAULT 0
);

-- +goose Down

DROP TABLE settings;
DROP TABLE audit;
DROP INDEX domains_active_host;
DROP TABLE domains;
DROP TABLE tokens;
DROP TABLE project_grants;
DROP TABLE members;
DROP TABLE pending_key_revokes;
DROP TABLE orgs;
DROP TABLE version_authors;
DROP TABLE invites;
DROP TABLE login_failures;
DROP TABLE login_events;
DROP TABLE recovery_codes;
DROP TABLE user_totp;
DROP TABLE sessions;
DROP TABLE identities;
DROP TABLE users;
