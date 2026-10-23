-- +goose Up

-- The router route table maps a custom host to its app slug; keep the slug next to the service id.
ALTER TABLE domains ADD COLUMN app_slug TEXT NOT NULL DEFAULT '';

-- +goose Down

ALTER TABLE domains DROP COLUMN app_slug;
