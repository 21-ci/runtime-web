# Runtime Web

React console plus a TypeScript backend that runs as a 21 Cloud Runtime service
(docs/contributing/architecture.md).

## Module map

| Dir | Responsibility |
|-----|----------------|
| `server/src/main.ts` | Runtime entry: wires storage, config, rtctl SDK, hasher, apps lookup; `scheduled()` jobs |
| `server/src/app.ts` | Composition root (`Deps`, `registerX` per feature; `registerAuth` first, `registerSpa` last) |
| `server/src/config.ts` | Env config, validated fail-closed (`RTWEB_*`) |
| `server/src/http/` | Router, JSON/error envelope, validation, cookies |
| `server/src/runtime/` | Control-API client over `sdk("rtctl")`; `errors.ts` is the one runtime→api-web error mapper |
| `server/src/authz/policy.ts` | Action rules (`can`); `orgs/members.ts` `orgAccess`/`authorize` apply them per request |
| `server/src/audit/` | The one audit writer (`audit`, `auditStmt`, `auditIn`) and listing |
| `server/src/{auth,users,orgs,invites,keys,apps,domains}/` | Feature services; routes in `server/src/routes/` |
| `server/src/db/` | Schema migrations (v1 init, v2 domains/audit flag) |
| `server/sdk/rtctl/` | Operator SDK published to the node |
| `server/scripts/` | `install.mjs`, `deploy.mjs`, `gen-assets.mjs` |
| `web/` | React console (built to `web/dist`, embedded by `gen-assets`) |
| `deploy/` | Node `rt.toml` fragment and Caddy relay |
| `e2e/` | Playwright smoke against a hosted console (`RTWEB_URL`) |
| `docs/reference/api.md` | HTTP contract (guarded by `server/test/contract.test.ts`) |
| `docs/contributing/code-style.md` | Binding code style (read before writing code) |
| `docs/` | User, admin, security and API docs (MkDocs site, `mkdocs.yml`); contributor guides in `docs/contributing/` |
| `install.sh`, `.github/` | Host installer; CI, security scans and signed releases (`docs/contributing/ci-cd.md`) |
| `AGENTS.md` | Guide for AI coding agents working on this repo |

## Commands

- `make help`: list targets
- `make ci`: web lint/test, web budgets, server typecheck/lint/tests
- `make server-test`: server unit tests (`cd server && npm test`)
- `make server-install`: idempotent install onto a runtime node (needs `RT_ROOT_TOKEN`)
- `make coverage`: web + server tests with v8 coverage thresholds
- `make e2e`: Playwright smoke (needs `RTWEB_URL`)
