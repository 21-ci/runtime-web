---
name: add-api-endpoint
description: Use when adding or changing an HTTP endpoint of the Runtime Web API (server/src/routes, authorization action, storage and rtctl runtime calls, error mapping, Vitest tests, console client hook, MSW handlers and docs/reference/api.md).
---

# Add an API endpoint

Every route in the console API is registered with an authorization rule, and every change to its contract updates the
reference, the client and the tests in the same PR. Follow these steps in order.

## 0. Read first

- `AGENTS.md` (layout and rules) and `docs/contributing/code-style.md` (binding style).
- `docs/reference/api.md`: the conventions (§1), the error envelope (§1.4) and the shared types (§2). Find the section
  that owns your route. Match its table format.
- `server/src/app.ts` (composition root, `Deps`) and a neighbouring route module in `server/src/routes/` as a model:
  `projects.ts` for an org-scoped route, `apps.ts` for an app route, `admin_users.ts` for an instance-admin route.

## 1. Choose the access rule

- Public routes are the exception (setup, login, invite accept). Everything else wraps its handler in
  `requireSession(deps, withRuntimeErrors(h))` (`server/src/auth/middleware.ts`), which applies the session, CSRF,
  Origin and gate checks.
- Org-scoped routes call `orgAccess(deps, user, ctx.params.org)` and then `authorize` / `can()` with an action
  (`server/src/orgs/members.ts`, `server/src/authz/policy.ts`). A non-member gets `404`, a visible resource with too
  low a role gets `403`.
- A new action goes into `server/src/authz/policy.ts` with a case in `server/test/authz/`. Never check a role inline.

## 2. Register the route

Add `r.get/post/put/patch/delete("/api/...", handler)` in the area's `registerX(router, deps)`. A new area gets a new
`server/src/routes/<area>.ts` and one `registerX` line in `server/src/app.ts` (before `registerSpa`, which must stay
last).

## 3. Data and runtime calls

- SQL goes through `dbOf(deps)` (`server/src/auth/types.ts`, over the `Storage` interface). Plain SQL, no ORM. Schema changes append a
  new migration to `server/src/db/schema.ts` (idempotent, valid on runtime SQLite and `node:sqlite`); never edit an
  applied one.
- Calls to the runtime control API go through `server/src/runtime/client.ts` over the `rtctl` SDK. If the call needs
  a control-API path the bindings do not allow yet, add it to `allowed_paths` in `deploy/rt.rtweb.toml` and to the
  SDK's path checks in `server/sdk/rtctl/mod.ts`. Teach `server/test/fakes/rtctl.ts` to answer it.
- Secrets are sealed with `server/src/crypto/seal.ts` before they are stored and never returned by a read route.
- State changes record an audit entry through `server/src/audit/`.

## 4. Errors and tests

- Throw the helpers in `server/src/http/errors.ts` (`notFound()`, `forbidden()`, `conflict(code, msg)`,
  `invalid(fields)`). Runtime failures are mapped by `withRuntimeErrors` / `server/src/runtime/errors.ts`. A new
  error code is added to §1.5 of `docs/reference/api.md`.
- Tests are Vitest in `server/test/<area>/`, through `testApp()` (`server/test/harness.ts`) and the area's
  `helpers.ts` (`seedOrg`, `people`, `call`).
- Cover: the happy path, each authorization outcome (`404` for a non-member, `403` for a wrong role), each documented
  error code, and the audit entry.
- Run `cd server && npx vitest run test/<area>`, then `make server-ci`.
- `server/test/contract.test.ts` checks that every route in `docs/reference/api.md` is registered. It must pass.

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
make ci && make coverage
```

Then open the PR with a Conventional Commit title such as `feat(api): add ...`. Mention the authorization rule and the
new error codes in the PR body.

## Checklist

- [ ] Access rule chosen and enforced with `requireSession` + `orgAccess` / `can()`, not by an inline role check
- [ ] Migration appended (if any); bindings and SDK paths extended (if any); fake rtctl updated
- [ ] Sealed values never returned; audit entry written for state changes
- [ ] Errors use `server/src/http/errors.ts` and the existing codes where possible
- [ ] Vitest tests cover the outcomes listed in step 4
- [ ] Console hook, MSW handlers and component test updated
- [ ] `docs/reference/api.md` updated in the same change
- [ ] `make ci` passes
