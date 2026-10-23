-- name: CreateDomain :exec
INSERT INTO domains (id, org_id, project_slug, service_id, app_slug, host, token, status, created_at)
VALUES (sqlc.arg(id), sqlc.arg(org_id), sqlc.arg(project_slug), sqlc.arg(service_id), sqlc.arg(app_slug), sqlc.arg(host), sqlc.arg(token), sqlc.arg(status), sqlc.arg(created_at));

-- name: GetDomain :one
SELECT * FROM domains WHERE id = sqlc.arg(id);

-- name: ListDomainsByOrg :many
SELECT * FROM domains WHERE org_id = sqlc.arg(org_id) ORDER BY host;

-- name: ListDomainsByService :many
SELECT * FROM domains WHERE org_id = sqlc.arg(org_id) AND service_id = sqlc.arg(service_id) ORDER BY host;

-- name: ListDomainsByStatus :many
SELECT * FROM domains WHERE status = sqlc.arg(status) ORDER BY host;

-- name: ActiveDomainByHost :one
SELECT * FROM domains WHERE host = sqlc.arg(host) AND status = 'active';

-- name: UpdateDomainStatus :execrows
UPDATE domains SET status = sqlc.arg(status) WHERE id = sqlc.arg(id);

-- name: ActivateDomain :execrows
UPDATE domains SET status = 'active', verified_at = sqlc.arg(at), last_checked_at = sqlc.arg(at), txt_misses = 0
WHERE id = sqlc.arg(id) AND status <> 'active';

-- name: SetDomainCheck :exec
UPDATE domains SET last_checked_at = sqlc.arg(at), txt_misses = sqlc.arg(txt_misses) WHERE id = sqlc.arg(id);

-- name: DeleteDomain :execrows
DELETE FROM domains WHERE id = sqlc.arg(id);

-- name: SetDomainCert :execrows
UPDATE domains SET cert_status = sqlc.arg(cert_status), cert_not_after = sqlc.arg(cert_not_after), cert_error = sqlc.arg(cert_error)
WHERE host = sqlc.arg(host) AND status = 'active';

-- name: ListActiveRoutes :many
SELECT host, app_slug FROM domains WHERE status = 'active' ORDER BY host;

-- name: ListAllDomains :many
SELECT d.id, d.org_id, d.project_slug, d.service_id, d.host, d.status, d.last_checked_at, d.created_at,
       o.slug AS org_slug, o.name AS org_name
FROM domains d JOIN orgs o ON o.id = d.org_id
ORDER BY d.host;
