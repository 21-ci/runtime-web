-- name: UpsertGrant :exec
INSERT INTO project_grants (org_id, user_id, project_slug, role)
VALUES (sqlc.arg(org_id), sqlc.arg(user_id), sqlc.arg(project_slug), sqlc.arg(role))
ON CONFLICT (org_id, user_id, project_slug) DO UPDATE SET role = excluded.role;

-- name: ListGrantsForUser :many
SELECT * FROM project_grants WHERE org_id = sqlc.arg(org_id) AND user_id = sqlc.arg(user_id) ORDER BY project_slug;

-- name: DeleteGrant :execrows
DELETE FROM project_grants WHERE org_id = sqlc.arg(org_id) AND user_id = sqlc.arg(user_id) AND project_slug = sqlc.arg(project_slug);

-- name: DeleteGrantsForUser :execrows
DELETE FROM project_grants WHERE org_id = sqlc.arg(org_id) AND user_id = sqlc.arg(user_id);
