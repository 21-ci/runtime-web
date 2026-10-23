-- name: InsertAudit :exec
INSERT INTO audit (id, at, actor_user_id, as_instance_admin, org_id, action, target, detail)
VALUES (sqlc.arg(id), sqlc.arg(at), sqlc.arg(actor_user_id), sqlc.arg(as_instance_admin), sqlc.arg(org_id), sqlc.arg(action), sqlc.arg(target), sqlc.arg(detail));

-- name: ListAuditByOrg :many
SELECT * FROM audit WHERE org_id = sqlc.arg(org_id) ORDER BY at DESC, id DESC LIMIT sqlc.arg(limit);

-- name: ListAudit :many
SELECT * FROM audit ORDER BY at DESC, id DESC LIMIT sqlc.arg(limit);

-- name: ListAuditFiltered :many
SELECT * FROM audit
WHERE (sqlc.narg(org_id) IS NULL OR org_id = sqlc.narg(org_id))
  AND (sqlc.narg(actor_user_id) IS NULL OR actor_user_id = sqlc.narg(actor_user_id))
  AND (sqlc.narg(action) IS NULL OR action = sqlc.narg(action))
  AND (sqlc.narg(before_at) IS NULL OR at < sqlc.narg(before_at) OR (at = sqlc.narg(before_at) AND id < sqlc.narg(before_id)))
ORDER BY at DESC, id DESC LIMIT sqlc.arg(limit);
