-- name: CreateSession :exec
INSERT INTO sessions (id_hash, user_id, csrf, mfa_pending, created_at, last_seen_at, expires_at, ip, user_agent)
VALUES (sqlc.arg(id_hash), sqlc.arg(user_id), sqlc.arg(csrf), sqlc.arg(mfa_pending), sqlc.arg(created_at), sqlc.arg(last_seen_at), sqlc.arg(expires_at), sqlc.arg(ip), sqlc.arg(user_agent));

-- name: GetSession :one
SELECT * FROM sessions WHERE id_hash = sqlc.arg(id_hash);

-- name: TouchSession :execrows
UPDATE sessions SET last_seen_at = sqlc.arg(last_seen_at) WHERE id_hash = sqlc.arg(id_hash);

-- name: DeleteSession :execrows
DELETE FROM sessions WHERE id_hash = sqlc.arg(id_hash);

-- name: DeleteExpiredSessions :execrows
DELETE FROM sessions WHERE expires_at < sqlc.arg(now);

-- name: ListSessionsForUser :many
SELECT * FROM sessions WHERE user_id = sqlc.arg(user_id) AND mfa_pending = 0 ORDER BY created_at DESC, id_hash;

-- name: DeleteSessionsForUserExcept :execrows
DELETE FROM sessions WHERE user_id = sqlc.arg(user_id) AND id_hash <> sqlc.arg(except_id_hash);
