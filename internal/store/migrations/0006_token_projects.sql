-- +goose Up

-- Runtime v0.1.1 restricts keys by project and environment, not by service. Old app slugs cannot be
-- mapped, so existing restrictions are cleared (their runtime keys are gone with the runtime schema reset).
ALTER TABLE tokens RENAME COLUMN apps TO projects;
UPDATE tokens SET projects = '[]';
ALTER TABLE tokens ADD COLUMN environments TEXT NOT NULL DEFAULT '[]';

-- +goose Down

ALTER TABLE tokens DROP COLUMN environments;
ALTER TABLE tokens RENAME COLUMN projects TO apps;
