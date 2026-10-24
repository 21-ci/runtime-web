# AGENTS.md

Instructions for coding agents working **on this repository**: the Runtime Web console. If you are writing an App
that runs **on** 21 Cloud Runtime, this is the wrong guide; see the runtime repository instead.

## What this is

A self-hosted console for writing, deploying and running small apps on 21 Cloud Runtime. It has an org and project
model, an in-browser code editor, logs, triggers, tokens, custom domains and an instance admin console. The console
is a React single-page app (`web/`) on top of a JSON API. The API backend is being moved to run as an **App on 21
Cloud Runtime**. Until that lands, the Go code under `cmd/` and `internal/` is the reference implementation, so read
it before you change behaviour.

Vocabulary, use it exactly:

- **App**: a unit of user code deployed to the runtime. Never call it a "val", "service", "function" or "worker" in
  UI copy, docs or new identifiers. The runtime's own word for the same thing is service, so write `app` in this repo.
- **Org**, **project**, **member**, **grant**: the access model. Org roles are `owner`, `admin` and `member`; project
  roles are `admin`, `developer` and `viewer`.
- **Token**: a scoped credential the console or a user creates. **Key**: the default org key.

## Layout

| Path | Contents |
|---|---|
| `cmd/rtweb/` | console server entry point and the `admin` subcommand |
| `cmd/rtrouter/` | host router: console host, app hosts, custom domains, TLS |
| `internal/api/` | HTTP routes, route registry, error envelope, SSE log stream |
| `internal/auth/`, `internal/authz/` | sessions, CSRF, MFA, OAuth; the role and action rules |
| `internal/apps/`, `internal/orgs/`, `internal/invites/`, `internal/keys/` | apps, orgs and members, invites, tokens |
| `internal/domains/`, `internal/router/` | custom domain verification, routing table, TLS |
| `internal/runtime/` | client for the 21 Cloud Runtime control API; `runtimetest/` is a fake runtime for tests |
| `internal/store/` | SQLite access: `migrations/`, `queries/` (sqlc), generated `db/` |
| `internal/config/`, `internal/seal/`, `internal/netx/`, `internal/audit/`, `internal/users/`, `internal/admin/` | config from env, AES-GCM sealing, networking helpers, audit, user management, admin commands |
| `internal/apperr/` | shared domain errors; the API layer maps them to HTTP codes |
| `web/` | the console: Vite, React 19, TanStack Router and Query, Tailwind v4 |
| `web/src/routes/` | file routes (TanStack Router) |
| `web/src/components/ui/` | primitives (button, dialog, table, ...) |
| `web/src/components/features/<feature>/` | feature code and its tests |
| `web/src/hooks/`, `web/src/lib/` | shared Query hooks; API client and shared types |
| `web/src/test/` | Vitest setup, MSW handlers and render helpers |
| `e2e/` | Playwright smoke suite against the compose stack |
| `deploy/` | runtime config and compose overlays (ACME test CA) |
| `scripts/` | bundle budget gate and its tests |
| `docs/` | MkDocs site: user, admin, security, reference and contributing pages |
| `.claude/skills/` | project skills for UI work, API endpoints and releases |

## Commands

| Command | Does |
|---|---|
| `make help` | list targets |
| `make ci` | the CI chain: format check, vet, tests, vulnerability scan, web lint and tests, build, budgets |
| `make test` | server tests |
| `make web-test` / `make web-lint` | console tests and lint |
| `make build` | build `bin/rtweb` (embeds the console) |
| `make e2e` | compose stack plus the Playwright smoke suite |
| `make docker` | build the `rtweb` and `rtrouter` images |

`make ci` must pass before a change is done. Run the narrowest test while iterating.

## Style

- Read [docs/contributing/code-style.md](docs/contributing/code-style.md) before you write code. It is binding.
- Go: stdlib first, `log/slog`, wrap errors as `fmt.Errorf("pkg: what: %w", err)`, SQL in `internal/store/queries/`.
- Console: data goes through TanStack Query hooks only (never `fetch` inside a component). Use the primitives in
  `web/src/components/ui/` and the tokens in [docs/contributing/design-tokens.md](docs/contributing/design-tokens.md).
- Tests: table-driven with `t.Run` in Go; Vitest with Testing Library and MSW in the console.
- Comments explain why, not what. Do not reference planning documents, task numbers or design doc sections in code.

## Rules

1. **Never write secrets, tokens or real keys** into code, fixtures, logs or docs. Use `dev-insecure-*` placeholders
   only in `.env.example`, and only for local development.
2. **Security-sensitive paths need care**: sessions, CSRF and Origin checks, authorization (`internal/authz`), sealing,
   domain verification, the router, and anything that reads a secret. Keep the existing checks; add tests for new ones.
3. **Authorization is enforced on the server.** A hidden button is not a check. Every org-scoped route states its
   action and passes through the org access helper.
4. **Keep the HTTP contract in step.** When an endpoint changes, update [docs/reference/api.md](docs/reference/api.md),
   the console's MSW handlers and hooks, and the tests in the same change.
5. **Do not add new dependencies casually.** Justify each one in the PR.
6. **Do not commit `.env`, `data/`, `bin/` or build output.**
7. **Use the App vocabulary** in every user-facing string and doc (see above).
8. **Do not edit generated code by hand**: `internal/store/db/` is generated from `internal/store/queries/` with sqlc.
9. **Commits**: Conventional Commits, and sign off with `git commit -s` when you can.

## Skills

Project skills in [`.claude/skills/`](.claude/skills/):

- `ui-design`: tokens, pill buttons, the color map for tags, accessibility, and how to add a page or feature with Query hooks and MSW tests
- `add-api-endpoint`: adding an HTTP route end to end, with its registry entry, tests, client hook and reference doc
- `release`: cutting a version, from the changelog to the tag and images
