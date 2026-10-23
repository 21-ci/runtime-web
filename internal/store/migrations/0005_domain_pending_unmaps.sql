-- +goose Up

-- Runtime host mappings the web dropped (domain removed or deactivated) whose runtime DELETE has not
-- succeeded yet. The domains checker retries them until the runtime confirms.
CREATE TABLE pending_unmaps (
    id         TEXT PRIMARY KEY,
    org_id     TEXT NOT NULL,
    service_id TEXT NOT NULL,
    host       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- +goose Down

DROP TABLE pending_unmaps;
