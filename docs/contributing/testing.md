---
title: Testing and coverage
description: Which test suites Runtime Web runs, how to run one test while you work, and the coverage gates CI enforces.
---

# Testing and coverage

Runtime Web has three suites, all run by `make ci` and `make coverage`. Run the narrowest test while you iterate, then
the full chain before you push.

| Suite | Where | Runs with | What it covers |
|---|---|---|---|
| Server unit tests | `server/test/` | Vitest, `make server-test` | Routes, authorization, storage, the runtime client, audit, sessions, MFA, domains |
| Console tests | `web/src/**/*.test.tsx` | Vitest and Testing Library, `make web-test` | Pages and components against MSW handlers, with no backend |
| End-to-end smoke | `e2e/` | Playwright, `make e2e` | A deployed console: sign-in, the main pages, an app |

Neither unit suite needs a runtime node. The server runs the whole app in memory: `testApp()` in
`server/test/harness.ts` wires the real code to `node:sqlite`, a `Map` for KV and a fake `rtctl` from `server/test/fakes/`.
The console mocks the API with MSW handlers in `web/src/test/msw.ts`.

## Run a narrow test

```bash
cd server && npx vitest run test/orgs              # one server area
cd server && npx vitest run --project integration   # the integration project, against the same harness
cd web && npx vitest run src/components/features/apps   # one console feature
cd web && npx vitest                                # watch mode
```

## Run the full checks

```bash
make ci          # web build, lint, tests and budgets; server typecheck, lint and unit tests
make coverage    # both suites under v8 coverage, with the thresholds below
```

`make budget` runs the gzip budgets of `web/dist` by itself. With `RTWEB_URL` set, it also checks the service health of
the deployed console.

## Coverage gates

Each suite has coverage thresholds in its Vitest config: `web/vitest.config.ts` and `server/vitest.config.ts`. CI fails
when coverage drops below them. Reports go to `web/coverage/` and `server/coverage/`.

Raise a threshold when coverage improves. Never lower one to make a pull request pass.

## The API contract test

`server/test/contract.test.ts` reads the endpoint tables in [`docs/reference/api.md`](../reference/api.md) and fails when a
documented route is not registered. When you add or change an endpoint, update the reference, the route, the console's
MSW handlers and the tests in the same change. See [Adding an endpoint or a page](adding-endpoints-and-pages.md).

## End-to-end smoke tests

The Playwright suite in `e2e/` runs against a console that a runtime node hosts. Set `RTWEB_URL` to its address and run:

```bash
RTWEB_URL=https://console.example.com make e2e
```

The target installs the Chromium browser for Playwright the first time. The smoke test runs first-run setup, then creates
an org, a two-factor enrollment, an app and an invite. It needs an instance that has not been set up yet, and it must
never point at production. Use a throwaway instance, and set `RTWEB_SETUP_TOKEN` to that instance's setup token.

## Writing tests

- Cover the main logic of a change: request paths, authorization rules, limits and the user-visible error messages.
- Use the helpers that exist: `testApp()` and the fakes on the server, Testing Library, `web/src/test/render.tsx` and
  MSW in the console.
- Keep tests deterministic. Pass the clock and the random source in through the app's dependencies rather than reading
  global time.
- A test that fails only under load is rerun alone before anyone calls it a real failure.
