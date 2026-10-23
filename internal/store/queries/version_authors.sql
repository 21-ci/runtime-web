-- name: UpsertVersionAuthor :exec
INSERT INTO version_authors (org_id, service_id, version, user_id, created_at)
VALUES (sqlc.arg(org_id), sqlc.arg(service_id), sqlc.arg(version), sqlc.arg(user_id), sqlc.arg(created_at))
ON CONFLICT (service_id, version) DO NOTHING;

-- name: GetVersionAuthor :one
SELECT * FROM version_authors WHERE service_id = sqlc.arg(service_id) AND version = sqlc.arg(version);

-- name: ListVersionAuthors :many
SELECT va.version, va.user_id, u.name
FROM version_authors va
JOIN users u ON u.id = va.user_id
WHERE va.org_id = sqlc.arg(org_id) AND va.service_id = sqlc.arg(service_id)
ORDER BY va.version;
