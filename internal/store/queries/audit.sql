-- name: InsertAudit :exec
INSERT INTO audit (id, at, actor_user_id, as_instance_admin, org_id, action, target, detail)
VALUES (sqlc.arg(id), sqlc.arg(at), sqlc.arg(actor_user_id), sqlc.arg(as_instance_admin), sqlc.arg(org_id), sqlc.arg(action), sqlc.arg(target), sqlc.arg(detail));

-- name: ListAuditByOrg :many
SELECT * FROM audit WHERE org_id = sqlc.arg(org_id) ORDER BY at DESC, id DESC LIMIT sqlc.arg(limit);

-- name: ListAudit :many
SELECT * FROM audit ORDER BY at DESC, id DESC LIMIT sqlc.arg(limit);
