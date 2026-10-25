---
title: Adding an endpoint or a page
description: The steps and the project skills for adding an HTTP endpoint to the server or a page to the console.
---

# Adding an endpoint or a page

A new feature usually touches both halves of the repository: a route on the server, a hook and a page in the console,
and the docs. The repository keeps step-by-step guides for both as project skills in
[`.claude/skills/`](https://github.com/21-ci/runtime-web/tree/main/.claude/skills). Coding agents load them
automatically. Contributors can read them as checklists.

## Add an HTTP endpoint

Use the `add-api-endpoint` skill. It covers the whole path, in this order:

1. **Route.** Add the handler in the feature's file under `server/src/routes/`. Keep the handler thin, and put the
   logic in the feature service under `server/src/<feature>/`.
2. **Authorization.** Name the action for the route in `server/src/authz/policy.ts`, and check it on every org-scoped
   route through the org access helper in `server/src/orgs/members.ts`. A hidden button in the console is not an
   authorization check.
3. **Storage and runtime calls.** Use the storage adapter for `std:sql`. Reach the runtime only through the `rtctl`
   SDK, and map runtime errors in `server/src/runtime/errors.ts`.
4. **Errors.** Return errors through `server/src/http/errors.ts`, with a stable, snake_case `code`.
5. **Tests.** Add Vitest tests under `server/test/`, with `testApp()` and the fakes. Cover the happy path, the
   authorization failures and the validation errors.
6. **Reference.** Document the route in [`docs/reference/api.md`](../reference/api.md). The contract test in
   `server/test/contract.test.ts` fails until the route and the document agree.
7. **Console client.** Add the request to the console's API layer, as a TanStack Query hook. Components never call
   `fetch` themselves. Add the MSW handler in `web/src/test/` so the console tests run without a backend.

Run `make ci` and `make coverage` before you open the pull request.

## Add a console page

Use the `ui-design` skill. It covers the design tokens, the primitives and how a page is built:

1. **Route.** Add a file route under `web/src/routes/`. The route file only loads data and renders a feature component.
2. **Feature.** Put the page's components in `web/src/components/features/<feature>/`, next to their tests.
3. **Data.** Put the Query hooks in the feature. Read the existing hooks in `web/src/hooks/` and the feature before you
   add one.
4. **Primitives.** Use the components in `web/src/components/ui/` and the tokens from
   [Design tokens](design-tokens.md). Do not add a new colour or a new button style for one page.
5. **Navigation.** Add the page to the sidebar in `web/src/components/layout/sidebar.tsx`, and to the ⌘K menu in
   `web/src/components/layout/command-menu.tsx` when people need to find it by name.
6. **Tests.** Test the page with Testing Library against the MSW handlers. Test the empty, loading and error states.
7. **Accessibility.** Keep keyboard focus, labels and contrast. The contrast tests under `web/src/styles/` check the
   tokens.

## Things to remember

- Use the word **App** in the console, the docs and new identifiers. Do not call an app a "val", a "service" or a
  "function" in user-facing text.
- When behavior users see changes, update the user guide page for it in `docs/user-guide/` in the same pull request.
- A new dependency needs a reason in the pull request. Prefer what the repository already uses.
- Do not edit generated code by hand. `server/src/gen/` comes from `server/scripts/gen-assets.mjs`, and
  `web/src/routeTree.gen.ts` comes from the TanStack Router plugin.

## Next steps

- [Testing and coverage](testing.md)
- [Code style](code-style.md): the binding rules for the server and the console
- [Architecture](architecture.md): how the pieces fit together
