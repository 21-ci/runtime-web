-- name: CreateDomain :exec
INSERT INTO domains (id, org_id, project_slug, service_id, host, token, status, created_at)
VALUES (sqlc.arg(id), sqlc.arg(org_id), sqlc.arg(project_slug), sqlc.arg(service_id), sqlc.arg(host), sqlc.arg(token), sqlc.arg(status), sqlc.arg(created_at));

-- name: GetDomain :one
SELECT * FROM domains WHERE id = sqlc.arg(id);

-- name: ListDomainsByOrg :many
SELECT * FROM domains WHERE org_id = sqlc.arg(org_id) ORDER BY host;

-- name: UpdateDomainStatus :execrows
UPDATE domains SET status = sqlc.arg(status) WHERE id = sqlc.arg(id);

-- name: ListAllDomains :many
SELECT d.id, d.org_id, d.project_slug, d.service_id, d.host, d.status, d.last_checked_at, d.created_at,
       o.slug AS org_slug, o.name AS org_name
FROM domains d JOIN orgs o ON o.id = d.org_id
ORDER BY d.host;
