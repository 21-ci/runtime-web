-- name: UpsertVersionAuthor :exec
INSERT INTO version_authors (org_id, service_id, version, user_id, created_at)
VALUES (sqlc.arg(org_id), sqlc.arg(service_id), sqlc.arg(version), sqlc.arg(user_id), sqlc.arg(created_at))
ON CONFLICT (service_id, version) DO NOTHING;

-- name: GetVersionAuthor :one
SELECT * FROM version_authors WHERE service_id = sqlc.arg(service_id) AND version = sqlc.arg(version);
