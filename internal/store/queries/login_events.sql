-- name: InsertLoginEvent :exec
INSERT INTO login_events (id, at, user_id, email, ip, ua, method, result)
VALUES (sqlc.arg(id), sqlc.arg(at), sqlc.arg(user_id), sqlc.arg(email), sqlc.arg(ip), sqlc.arg(ua), sqlc.arg(method), sqlc.arg(result));

-- name: InsertLoginFailure :exec
INSERT INTO login_failures (ip, email, at) VALUES (sqlc.arg(ip), sqlc.arg(email), sqlc.arg(at));

-- name: CountLoginFailuresSince :one
SELECT COUNT(*) FROM login_failures WHERE ip = sqlc.arg(ip) AND email = sqlc.arg(email) AND at >= sqlc.arg(since);

-- name: DeleteLoginFailures :exec
DELETE FROM login_failures WHERE ip = sqlc.arg(ip) AND email = sqlc.arg(email);

-- name: DeleteLoginFailuresBefore :execrows
DELETE FROM login_failures WHERE at < sqlc.arg(before);

-- name: ListLoginEventsForUser :many
SELECT * FROM login_events WHERE user_id = sqlc.arg(user_id) ORDER BY at DESC, id DESC LIMIT sqlc.arg(lim);
