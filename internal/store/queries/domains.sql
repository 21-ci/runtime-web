-- name: CreateDomain :exec
INSERT INTO domains (id, org_id, project_slug, service_id, host, token, status, created_at)
VALUES (sqlc.arg(id), sqlc.arg(org_id), sqlc.arg(project_slug), sqlc.arg(service_id), sqlc.arg(host), sqlc.arg(token), sqlc.arg(status), sqlc.arg(created_at));

-- name: GetDomain :one
SELECT * FROM domains WHERE id = sqlc.arg(id);

-- name: ListDomainsByOrg :many
SELECT * FROM domains WHERE org_id = sqlc.arg(org_id) ORDER BY host;

-- name: UpdateDomainStatus :execrows
UPDATE domains SET status = sqlc.arg(status) WHERE id = sqlc.arg(id);
