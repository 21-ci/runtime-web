-- name: GetSetting :one
SELECT * FROM settings WHERE key = sqlc.arg(key);

-- name: UpsertSetting :exec
INSERT INTO settings (key, value, sealed) VALUES (sqlc.arg(key), sqlc.arg(value), sqlc.arg(sealed))
ON CONFLICT (key) DO UPDATE SET value = excluded.value, sealed = excluded.sealed;
