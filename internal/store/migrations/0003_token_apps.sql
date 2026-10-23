-- +goose Up

-- Custom tokens may be restricted to apps; store the app slugs shown in the console.
ALTER TABLE tokens ADD COLUMN apps TEXT NOT NULL DEFAULT '[]';

-- +goose Down

ALTER TABLE tokens DROP COLUMN apps;
