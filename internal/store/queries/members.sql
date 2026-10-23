-- name: AddMember :exec
INSERT INTO members (org_id, user_id, role) VALUES (sqlc.arg(org_id), sqlc.arg(user_id), sqlc.arg(role));

-- name: GetMember :one
SELECT * FROM members WHERE org_id = sqlc.arg(org_id) AND user_id = sqlc.arg(user_id);

-- name: ListMembers :many
SELECT * FROM members WHERE org_id = sqlc.arg(org_id) ORDER BY user_id;

-- name: UpdateMemberRole :execrows
UPDATE members SET role = sqlc.arg(role) WHERE org_id = sqlc.arg(org_id) AND user_id = sqlc.arg(user_id);

-- name: RemoveMember :execrows
DELETE FROM members WHERE org_id = sqlc.arg(org_id) AND user_id = sqlc.arg(user_id);

-- name: CountOwners :one
SELECT COUNT(*) FROM members WHERE org_id = sqlc.arg(org_id) AND role = 'owner';
