# AGENTS.md

Instructions for coding agents working **on this repository**: the Runtime Web console. If you are writing an App
that runs **on** 21 Cloud Runtime, this is the wrong guide; see the runtime repository instead.

## What this is

A self-hosted console for writing, deploying and running small apps on 21 Cloud Runtime. It has an org and project
model, an in-browser code editor, logs, triggers, tokens, custom domains and an instance admin console. The console
is a React single-page app (`web/`) on top of a JSON API. The API backend (`server/`) is TypeScript and runs as an
**App on 21 Cloud Runtime** (the service `rtweb`); the design is in
[docs/contributing/architecture.md](docs/contributing/architecture.md).

Vocabulary, use it exactly:

- **App**: a unit of user code deployed to the runtime. Never call it a "val", "service", "function" or "worker" in
  UI copy, docs or new identifiers. The runtime's own word for the same thing is service, so write `app` in this repo.
- **Org**, **project**, **member**, **grant**: the access model. Org roles are `owner`, `admin` and `member`; project
  roles are `admin`, `developer` and `viewer`.
- **Token**: a scoped credential the console or a user creates. **Key**: the default org key.

## Layout

| Path | Contents |
|---|---|
| `server/src/main.ts` | runtime entry: wires storage, config, the rtctl SDK, hasher, apps lookup; `scheduled()` jobs |
| `server/src/app.ts` | composition root (`Deps`, one `registerX` per feature) |
| `server/src/routes/` | HTTP routes per area; `server/src/http/` router, error envelope, validation, cookies |
| `server/src/auth/`, `server/src/authz/` | sessions, CSRF, Origin, MFA, OAuth; the role and action rules (`can`) |
| `server/src/{apps,orgs,invites,keys,domains,users,audit}/` | feature services |
| `server/src/runtime/` | control-API client over `sdk("rtctl")`; `errors.ts` maps runtime errors |
| `server/src/db/`, `server/src/storage/` | schema migrations; `std:sql` / `std:kv` adapters |
| `server/src/crypto/`, `server/src/config.ts` | AES-GCM sealing, argon2id, TOTP; env config |
| `server/sdk/rtctl/` | operator SDK published to the node (the one path to the control API) |
| `server/scripts/` | `install.mjs` (idempotent install), `deploy.mjs` (dev deploy), `gen-assets.mjs` (embeds `web/dist`) |
| `server/test/` | Vitest: `harness.ts` (`testApp()`), `fakes/` (fake rtctl), `contract.test.ts` (API doc guard) |
| `web/` | the console: Vite, React 19, TanStack Router and Query, Tailwind v4 |
| `web/src/routes/` | file routes (TanStack Router) |
| `web/src/components/ui/` | primitives (button, dialog, table, ...) |
| `web/src/components/features/<feature>/` | feature code and its tests |
| `web/src/hooks/`, `web/src/lib/` | shared Query hooks; API client and shared types |
| `web/src/test/` | Vitest setup, MSW handlers and render helpers |
| `e2e/` | Playwright smoke suite against a runtime-hosted console (`RTWEB_URL`) |
| `deploy/` | node `rt.toml` fragment (`rt.rtweb.toml`) and the Caddy site (`Caddyfile`) |
| `scripts/` | bundle budget gate and its tests, release notes |
| `install.sh` | host installer (runtime node, signed release, Caddy, `install.mjs`) |
| `.github/` | CI, security scans (Trivy, CodeQL, Scorecard), signed releases, Dependabot |
| `docs/` | MkDocs site: user, admin, security, reference and contributing pages |
| `.claude/skills/` | project skills for UI work, API endpoints and releases |

## Commands

| Command | Does |
|---|---|
| `make help` | list targets |
| `make ci` | the CI chain: web build, lint, tests and gzip budgets; server typecheck, lint and unit tests |
| `make coverage` | web + server tests with v8 coverage thresholds (CI gates on them) |
| `make server-test` | server unit tests |
| `make web-test` / `make web-lint` | console tests and lint |
| `make server-deploy` / `make server-install` | dev deploy / idempotent install onto a runtime node (`RT_ROOT_TOKEN`) |
| `make e2e` | Playwright smoke suite against a hosted console (`RTWEB_URL`) |

`make ci` must pass before a change is done. Run the narrowest test while iterating.

## Style

- Read [docs/contributing/code-style.md](docs/contributing/code-style.md) before you write code. It is binding.
- Server: strict TypeScript, runtime globals only in `server/src/main.ts`, errors through `server/src/http/errors.ts`,
  plain SQL with append-only migrations in `server/src/db/schema.ts`.
- Console: data goes through TanStack Query hooks only (never `fetch` inside a component). Use the primitives in
  `web/src/components/ui/` and the tokens in [docs/contributing/design-tokens.md](docs/contributing/design-tokens.md).
- Tests: Vitest everywhere; `testApp()` and `FakeRtCtl` on the server, Testing Library and MSW in the console.
- Comments explain why, not what. Do not reference planning documents, task numbers or design doc sections in code.

## Rules

1. **Never write secrets, tokens or real keys** into code, fixtures, logs or docs. Use `dev-insecure-*` placeholders
   only in `.env.example`, and only for local development.
2. **Security-sensitive paths need care**: sessions, CSRF and Origin checks, authorization (`server/src/authz`), sealing,
   domain verification, the `rtctl` SDK and bindings, the Caddy relay and `tls-ask`, and anything that reads a secret. Keep the existing checks; add tests for new ones.
3. **Authorization is enforced on the server.** A hidden button is not a check. Every org-scoped route states its
   action and passes through the org access helper.
4. **Keep the HTTP contract in step.** When an endpoint changes, update [docs/reference/api.md](docs/reference/api.md),
   the console's MSW handlers and hooks, and the tests in the same change (`server/test/contract.test.ts` checks
   that every documented route is registered).
5. **Do not add new dependencies casually.** Justify each one in the PR.
6. **Do not commit `.env`, `data/`, `bin/` or build output.**
7. **Use the App vocabulary** in every user-facing string and doc (see above).
8. **Do not edit generated code by hand**: `server/src/gen/` comes from `gen-assets.mjs`, `web/src/routeTree.gen.ts`
   from the TanStack Router plugin.
9. **Commits**: Conventional Commits, and sign off with `git commit -s` when you can.

## Skills

Project skills in [`.claude/skills/`](.claude/skills/):

- `ui-design`: tokens, pill buttons, the color map for tags, accessibility, and how to add a page or feature with Query hooks and MSW tests
- `add-api-endpoint`: adding an HTTP route end to end, with its registry entry, tests, client hook and reference doc
- `release`: cutting a version, from the changelog and package versions to the tag and the signed release
