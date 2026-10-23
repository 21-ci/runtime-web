-- +goose Up

-- Allow the mfa_pending result: a correct first factor awaiting its code.
CREATE TABLE login_events_new (
    id      TEXT PRIMARY KEY,
    at      INTEGER NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    email   TEXT NOT NULL DEFAULT '',
    ip      TEXT NOT NULL DEFAULT '',
    ua      TEXT NOT NULL DEFAULT '',
    method  TEXT NOT NULL CHECK (method IN ('password', 'oauth', 'invite')),
    result  TEXT NOT NULL CHECK (result IN ('ok', 'bad_password', 'bad_totp', 'rate_limited', 'disabled', 'sso_only', 'mfa_pending'))
);
INSERT INTO login_events_new SELECT id, at, user_id, email, ip, ua, method, result FROM login_events;
DROP TABLE login_events;
ALTER TABLE login_events_new RENAME TO login_events;

-- +goose Down

DELETE FROM login_events WHERE result = 'mfa_pending';
CREATE TABLE login_events_old (
    id      TEXT PRIMARY KEY,
    at      INTEGER NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    email   TEXT NOT NULL DEFAULT '',
    ip      TEXT NOT NULL DEFAULT '',
    ua      TEXT NOT NULL DEFAULT '',
    method  TEXT NOT NULL CHECK (method IN ('password', 'oauth', 'invite')),
    result  TEXT NOT NULL CHECK (result IN ('ok', 'bad_password', 'bad_totp', 'rate_limited', 'disabled', 'sso_only'))
);
INSERT INTO login_events_old SELECT id, at, user_id, email, ip, ua, method, result FROM login_events;
DROP TABLE login_events;
ALTER TABLE login_events_old RENAME TO login_events;
