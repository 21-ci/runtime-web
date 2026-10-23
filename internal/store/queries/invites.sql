-- name: CreateInvite :exec
INSERT INTO invites (id, email, org_id, role, token_hash, expires_at, created_by, created_at)
VALUES (sqlc.arg(id), sqlc.arg(email), sqlc.arg(org_id), sqlc.arg(role), sqlc.arg(token_hash), sqlc.arg(expires_at), sqlc.arg(created_by), sqlc.arg(created_at));

-- name: GetInviteByTokenHash :one
SELECT * FROM invites WHERE token_hash = sqlc.arg(token_hash);

-- name: MarkInviteUsed :execrows
UPDATE invites SET used_at = sqlc.arg(used_at) WHERE id = sqlc.arg(id) AND used_at IS NULL AND revoked_at IS NULL;

-- name: GetInviteByID :one
SELECT * FROM invites WHERE id = sqlc.arg(id);

-- name: RevokeInvite :execrows
UPDATE invites SET revoked_at = sqlc.arg(revoked_at) WHERE id = sqlc.arg(id) AND used_at IS NULL AND revoked_at IS NULL;

-- name: ListPendingInvites :many
SELECT i.id, i.email, i.org_id, i.role, i.expires_at, i.created_by, i.created_at,
       u.name AS creator_name, o.slug AS org_slug, o.name AS org_name
FROM invites i
JOIN users u ON u.id = i.created_by
LEFT JOIN orgs o ON o.id = i.org_id
WHERE i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > sqlc.arg(now_at)
ORDER BY i.created_at, i.id;

-- name: ListPendingInvitesByOrg :many
SELECT i.id, i.email, i.org_id, i.role, i.expires_at, i.created_by, i.created_at,
       u.name AS creator_name, o.slug AS org_slug, o.name AS org_name
FROM invites i
JOIN users u ON u.id = i.created_by
LEFT JOIN orgs o ON o.id = i.org_id
WHERE i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > sqlc.arg(now_at) AND i.org_id = sqlc.arg(org_id)
ORDER BY i.created_at, i.id;
