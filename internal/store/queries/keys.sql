-- name: CreateToken :exec
INSERT INTO tokens (id, org_id, runtime_key_id, name, scopes, projects, environments, expires_at, created_by, created_at)
VALUES (sqlc.arg(id), sqlc.arg(org_id), sqlc.arg(runtime_key_id), sqlc.arg(name), sqlc.arg(scopes), sqlc.arg(projects), sqlc.arg(environments), sqlc.arg(expires_at), sqlc.arg(created_by), sqlc.arg(created_at));

-- name: GetToken :one
SELECT * FROM tokens WHERE id = sqlc.arg(id) AND org_id = sqlc.arg(org_id);

-- name: ListTokensByOrg :many
SELECT * FROM tokens WHERE org_id = sqlc.arg(org_id) ORDER BY created_at, id;

-- name: ListLiveTokensByOrg :many
SELECT t.*, u.name AS creator_name FROM tokens t JOIN users u ON u.id = t.created_by
WHERE t.org_id = sqlc.arg(org_id) AND t.revoked_at IS NULL ORDER BY t.created_at, t.id;

-- name: RevokeToken :execrows
UPDATE tokens SET revoked_at = sqlc.arg(revoked_at) WHERE id = sqlc.arg(id) AND org_id = sqlc.arg(org_id) AND revoked_at IS NULL;

-- name: AddPendingKeyRevoke :exec
INSERT INTO pending_key_revokes (key_id, tenant_id, created_at) VALUES (sqlc.arg(key_id), sqlc.arg(tenant_id), sqlc.arg(created_at))
ON CONFLICT (key_id) DO NOTHING;

-- name: ListPendingKeyRevokes :many
SELECT * FROM pending_key_revokes ORDER BY created_at LIMIT sqlc.arg(limit);

-- name: IncPendingKeyRevokeAttempts :execrows
UPDATE pending_key_revokes SET attempts = attempts + 1 WHERE key_id = sqlc.arg(key_id);

-- name: DeletePendingKeyRevoke :execrows
DELETE FROM pending_key_revokes WHERE key_id = sqlc.arg(key_id);
