-- name: CreateUserTOTP :exec
INSERT INTO user_totp (user_id, secret_sealed, enabled_at, last_used_step)
VALUES (sqlc.arg(user_id), sqlc.arg(secret_sealed), sqlc.arg(enabled_at), sqlc.arg(last_used_step));

-- name: GetUserTOTP :one
SELECT * FROM user_totp WHERE user_id = sqlc.arg(user_id);

-- name: ActivateUserTOTP :execrows
UPDATE user_totp SET enabled_at = sqlc.arg(enabled_at) WHERE user_id = sqlc.arg(user_id) AND enabled_at IS NULL;

-- name: CreateRecoveryCode :exec
INSERT INTO recovery_codes (user_id, hash) VALUES (sqlc.arg(user_id), sqlc.arg(hash));

-- name: ConsumeRecoveryCode :execrows
UPDATE recovery_codes SET used_at = sqlc.arg(used_at)
WHERE user_id = sqlc.arg(user_id) AND hash = sqlc.arg(hash) AND used_at IS NULL;
