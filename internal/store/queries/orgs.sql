-- name: CreateOrg :exec
INSERT INTO orgs (id, slug, name, tenant_id, default_key_id, default_key_sealed, created_at)
VALUES (sqlc.arg(id), sqlc.arg(slug), sqlc.arg(name), sqlc.arg(tenant_id), sqlc.arg(default_key_id), sqlc.arg(default_key_sealed), sqlc.arg(created_at));

-- name: GetOrgByID :one
SELECT * FROM orgs WHERE id = sqlc.arg(id);

-- name: GetOrgBySlug :one
SELECT * FROM orgs WHERE slug = sqlc.arg(slug);

-- name: ListOrgsForUser :many
SELECT o.* FROM orgs o JOIN members m ON m.org_id = o.id
WHERE m.user_id = sqlc.arg(user_id) ORDER BY o.created_at, o.id;

-- name: ListOrgs :many
SELECT * FROM orgs ORDER BY created_at, id;

-- name: UpdateOrgName :execrows
UPDATE orgs SET name = sqlc.arg(name) WHERE id = sqlc.arg(id);

-- name: DeleteOrg :execrows
DELETE FROM orgs WHERE id = sqlc.arg(id);
