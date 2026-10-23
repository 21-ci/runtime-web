-- name: CreateInvite :exec
INSERT INTO invites (id, email, org_id, role, token_hash, expires_at, created_by, created_at)
VALUES (sqlc.arg(id), sqlc.arg(email), sqlc.arg(org_id), sqlc.arg(role), sqlc.arg(token_hash), sqlc.arg(expires_at), sqlc.arg(created_by), sqlc.arg(created_at));

-- name: GetInviteByTokenHash :one
SELECT * FROM invites WHERE token_hash = sqlc.arg(token_hash);

-- name: MarkInviteUsed :execrows
UPDATE invites SET used_at = sqlc.arg(used_at) WHERE id = sqlc.arg(id) AND used_at IS NULL AND revoked_at IS NULL;
