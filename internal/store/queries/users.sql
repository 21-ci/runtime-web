-- name: CreateUser :exec
INSERT INTO users (id, email, name, password_hash, must_change_password, is_instance_admin, disabled, created_at, updated_at)
VALUES (sqlc.arg(id), sqlc.arg(email), sqlc.arg(name), sqlc.arg(password_hash), sqlc.arg(must_change_password), sqlc.arg(is_instance_admin), sqlc.arg(disabled), sqlc.arg(created_at), sqlc.arg(updated_at));

-- name: GetUserByID :one
SELECT * FROM users WHERE id = sqlc.arg(id);

-- name: GetUserByEmail :one
SELECT * FROM users WHERE email = sqlc.arg(email);

-- name: CountUsers :one
SELECT COUNT(*) FROM users;

-- name: UpdateUserPassword :execrows
UPDATE users SET password_hash = sqlc.arg(password_hash), must_change_password = sqlc.arg(must_change_password), updated_at = sqlc.arg(updated_at)
WHERE id = sqlc.arg(id);

-- name: CreateIdentity :exec
INSERT INTO identities (id, user_id, provider, subject, email)
VALUES (sqlc.arg(id), sqlc.arg(user_id), sqlc.arg(provider), sqlc.arg(subject), sqlc.arg(email));

-- name: GetIdentity :one
SELECT * FROM identities WHERE provider = sqlc.arg(provider) AND subject = sqlc.arg(subject);

-- name: CreateFirstUser :execrows
INSERT INTO users (id, email, name, password_hash, must_change_password, is_instance_admin, disabled, created_at, updated_at)
SELECT sqlc.arg(id), sqlc.arg(email), sqlc.arg(name), sqlc.arg(password_hash), 0, 1, 0, sqlc.arg(created_at), sqlc.arg(created_at)
WHERE NOT EXISTS (SELECT 1 FROM users);

-- name: SetUserDisabled :execrows
UPDATE users SET disabled = sqlc.arg(disabled), updated_at = sqlc.arg(updated_at) WHERE id = sqlc.arg(id);
