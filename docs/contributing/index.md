---
title: Contributing
description: How to set up a checkout of Runtime Web, run its checks, and send a change that the maintainers can merge.
---

# Contributing

Thanks for helping. Runtime Web is a React console in `web/` and a TypeScript backend in `server/` that runs as an App
on 21 Cloud Runtime. These pages cover the day-to-day work. The short rules for a pull request are in
[CONTRIBUTING.md](https://github.com/21-ci/runtime-web/blob/main/CONTRIBUTING.md).

## Start here

1. [Dev setup](dev-setup.md): clone the repository, run `make ci`, and deploy to a local node if you need one.
2. [Testing and coverage](testing.md): which tests cover which code, and the coverage gates.
3. [Adding an endpoint or a page](adding-endpoints-and-pages.md): the steps for a new API route or console page.
4. [Code style](code-style.md) and [Design tokens](design-tokens.md): read them before you write code. They are binding.

## Reference

- [Architecture](architecture.md): the backend as a service on the runtime, its storage, the SDK and the edge
- [CI and releases](ci-cd.md): workflows, coverage gates, signed releases and the installer
- [Releases](releases.md): how a version is cut and tagged
- [HTTP API](../reference/api.md): every route, its auth rule and its errors
- [Configuration](../reference/configuration.md): every setting and where it lives

## Pull requests

- Keep one logical change in each pull request, and link the issue it closes.
- Write tests for the main logic: request paths, authorization rules, limits and user-visible errors.
- When behavior that users or operators see changes, update the docs in the same pull request: the
  [HTTP API](../reference/api.md), the [configuration](../reference/configuration.md) and the user guide.
- Changes that touch a trust boundary (sessions, CSRF, authorization, secrets, domains, the `rtctl` SDK, bindings, the
  Caddy relay) also update the [security model](../security-model.md) and ask for a security-aware review. Report
  vulnerabilities privately, as described in
  [SECURITY.md](https://github.com/21-ci/runtime-web/blob/main/SECURITY.md).
- Use [Conventional Commits](https://www.conventionalcommits.org) for commit messages and pull request titles, for
  example `feat(server): ...`, `fix(web): ...`, `docs: ...` or `chore: ...`. Add `!` after the type for a breaking
  change.
