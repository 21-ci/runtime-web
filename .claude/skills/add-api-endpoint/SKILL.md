---
name: add-api-endpoint
description: Use when adding or changing an HTTP endpoint of the Runtime Web API (internal/api routes, authorization action, store and runtime calls, error mapping, tests, console client hook, MSW handlers and docs/reference/api.md).
---

# Add an API endpoint

Every route in the console API is registered with an authorization rule, and every change to its contract updates the
reference, the client and the tests in the same PR. Follow these steps in order.

## 0. Read first

- `AGENTS.md` (layout and rules) and `docs/contributing/code-style.md` (binding style).
- `docs/reference/api.md`: the conventions (§1), the error envelope (§1.4) and the shared types (§2). Find the section
  that owns your route. Match its table format.
- `internal/api/registry.go`: `route`, `routePublic` and the `RouteSpec` fields (`Action`, `Public`, `Internal`).
- `internal/api/routes_org.go` for an org-scoped route, and `internal/api/routes_apps.go` for an app route, as models.

## 1. Decide the access rule

Pick one:

- **Public** (`routePublic`): no session. Use only for setup, login, MFA and invite acceptance. Origin still applies to
  unsafe methods.
- **Session** (`route`): any signed-in user. Pass an `authz.Action` only if the route is gated by one.
- **Org-scoped** (`orgRoute`): the route resolves `{org}` and the caller's role, then checks `authz.Action`. Use this for
  anything under `/api/orgs/{org}`. A non-member gets `404`; a member without the action gets `403`.
- **App-scoped**: resolve `{app}` with `apps.Resolve` inside the org, then check the action on the app's project.
- **Instance admin**: an `authz.InstanceAdmin` action.

If you need a new action, add it to `internal/authz/scopes.go` and `internal/authz/authz.go` with a table test in
`internal/authz/authz_test.go`. Never check a role inline in a handler.

## 2. Write the store and runtime code

- SQL goes in `internal/store/queries/<area>.sql`. Regenerate the Go code with sqlc (`internal/store/sqlc.yaml`). Do
  not edit `internal/store/db/` by hand.
- Schema changes add a new numbered migration in `internal/store/migrations/` (`NNNN_name.sql`). Never edit an applied one.
- Calls to the runtime go through `internal/runtime/` (typed client). Add a method there, and a case to
  `internal/runtime/runtimetest/` if the fake runtime needs to answer it.
- Secrets are sealed with `internal/seal` before they are stored. Secret values are never returned by any read route.
- Writes that change state record an audit entry through `internal/audit`.

## 3. Write the handler

- Use the stdlib router pattern (`GET /api/orgs/{org}/...`). Read path values with `r.PathValue`.
- Decode JSON strictly and validate. Return `422` with a field-level `details` where useful.
- Return domain errors from `internal/apperr` (for example `apperr.Conflict{Code: "stale"}`). The HTTP layer maps them to
  the error envelope `{"error":{"code","message"}}`. Add a new code to `internal/api/errors.go` and to §1.5 of the
  reference only when no existing code fits.
- Timestamps are unix milliseconds. Ids carry their prefix (`org_`, `usr_`, `tok_`, ...).
- For optimistic concurrency, use `ETag` and `If-Match` the way the app routes already do (`428` when missing, `409 stale`
  on mismatch).
- Paginate lists with the `Page<T>` shape (`pageJSON`) and keep cursors opaque.

## 4. Test it

- Go tests use the stdlib only (no testify), table-driven, with `t.Run`. Use `httptest` and the fake runtime
  (`runtimetest.NewServer(t)`) and in-memory SQLite. Put route tests next to the route (`routes_<area>_test.go`).
- Cover: the happy path, each authorization outcome (`404` for a non-member, `403` for a wrong role), each documented
  error code, and the audit entry.
- Run `make test`. For a single package, `go test ./internal/api -run TestYourRoute -v`.
- `TestEveryRouteChecksAuthz` walks the registry. It must still pass; it fails when a route has no rule.

## 5. Update the console

- Add or change the typed hook in the feature's `hooks.ts` (`useX` for reads, `useXMutation` for writes), following the
  Query key rules in the `ui-design` skill.
- Update the MSW handlers in `web/src/test/msw.ts` or the test's own `server.use(...)`.
- Add a component test for the user-visible path.
- Run `make web-test` and `make web-lint`.

## 6. Update the reference

In `docs/reference/api.md`, add or change the row in the section's table: method, path, auth (the action or `session`),
request, response and error codes. Add a TypeScript shape for any new body type in the same section. The docs site
builds from this file, so keep the format of the neighbouring rows.

If the route changes what a user can do, update the matching page in `docs/user-guide/` as well.

## 7. Check and ship

```bash
make ci
```

Then open the PR with a Conventional Commit title such as `feat(api): add ...`. Mention the authorization rule and the
new error codes in the PR body.

## Checklist

- [ ] Access rule chosen and enforced in the registry, not in the handler
- [ ] Store query, migration and sqlc output added; no hand-edited generated code
- [ ] Sealed values never returned; audit entry written for state changes
- [ ] Errors use `apperr` and the existing codes where possible
- [ ] Go tests cover the outcomes listed in step 4
- [ ] Console hook, MSW handlers and component test updated
- [ ] `docs/reference/api.md` updated in the same change
- [ ] `make ci` passes
