# Contributing

Thanks for helping. This guide covers the dev setup, the checks a change must pass, and how a change gets merged.
Questions go to [Discussions](https://github.com/21-ci/runtime-web/discussions). Security bugs go through
[SECURITY.md](SECURITY.md), never a public issue.

## Ground rules

- Open an issue or a discussion before a large change, so the design is agreed before the code.
- One logical change per PR. Small PRs are reviewed faster.
- Cover the main logic with tests: request paths, authorization rules, limits, user-visible errors. Use the helpers in
  `server/test/` (`harness.ts`, `fakes/`) and `web/src/test/`.
- User-visible behaviour (HTTP API, config keys, limits, UI copy that documents a rule) changes together with its docs.
  The API reference is [`docs/reference/api.md`](docs/reference/api.md); the config reference is
  [`docs/configuration.md`](docs/configuration.md).
- Changes that touch a trust boundary (sessions, CSRF, authorization, secrets, domains, the rtctl SDK and bindings, the Caddy relay) also update
  [SECURITY.md](SECURITY.md) or the security model docs, and ask for a security-aware review.
- Commit messages and PR titles use [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`,
  `docs:`, `chore:`, `feat!:` for a breaking change).
- Contributions are accepted under the Apache License 2.0 (see [LICENSE](LICENSE)).

## Dev setup

| Need | Why |
|---|---|
| Node.js 22.5+ | the console (`web/`) and the backend (`server/`): npm, Vite, Vitest, `node:sqlite` in server tests |
| GNU make | every task below is a `make` target |
| optional: a local 21 Cloud Runtime node | `make server-deploy` and `make e2e` against a hosted console |
| Python 3.10+ | the docs site (`docs/requirements.txt`) |
| optional: `shellcheck`, `actionlint`, `gitleaks` | what CI runs on `install.sh`, the workflows and secrets |

```bash
git clone https://github.com/21-ci/runtime-web && cd runtime-web
make ci           # installs web and server dependencies, builds, lints and tests both
```

Both test suites run without a runtime node: the console mocks the API with MSW, the server runs the whole app over
an in-memory harness (node:sqlite, a Map for KV, a fake `rtctl`). To try a change in a real console, start a local
runtime node, then `cp .env.example .env`, `set -a; . ./.env; set +a` and `make server-deploy`. The
`dev-insecure-*` values are placeholders; never reuse them outside local development.

## Make targets

`make help` lists all of them. The ones you need daily:

| Target | Does |
|---|---|
| `make ci` | the CI chain: web build, lint, tests and gzip budgets; server typecheck, lint and unit tests |
| `make coverage` | web + server tests with v8 coverage thresholds |
| `make web-test` / `make web-lint` | console tests (Vitest, Testing Library, MSW) and ESLint |
| `make server-test` | server unit tests (Vitest) |
| `make server-deploy` | dev deploy of `server/` to a local runtime node (needs `RT_ROOT_TOKEN`) |
| `make server-install` | idempotent install onto a runtime node (`server/scripts/install.mjs`) |
| `make e2e` | Playwright smoke suite against a runtime-hosted console (needs `RTWEB_URL`) |

## Tests

Run the narrowest test that covers your change while iterating, then the full chain before you push:

```bash
cd server && npx vitest run test/orgs    # one server area
cd web && npx vitest run src/components/features/apps
make ci && make coverage
```

`server/test/contract.test.ts` parses the endpoint tables in [`docs/reference/api.md`](docs/reference/api.md) and
fails when a documented route is not registered. When you change an endpoint,
update that file and the console's MSW handlers under `web/src/test/` in the same PR.

## Pull requests

1. Fork, branch from `main`, and keep the branch focused.
2. Make sure `make ci` passes locally.
3. Fill in the PR template: what changed, why, how you tested it, and any doc or security impact.
4. Expect at least one maintainer review. Code owners review security-sensitive paths.
5. Maintainers merge with a squash commit whose title is the PR title.

## Developer Certificate of Origin

By contributing, you certify that you wrote the change or have the right to submit it under the project license.
Sign your commits with `git commit -s` (`Signed-off-by: Your Name <you@example.com>`) when you can.

## Code style and design

- Code style: [docs/contributing/code-style.md](docs/contributing/code-style.md)
- Design tokens and the UI look: [docs/contributing/design-tokens.md](docs/contributing/design-tokens.md)
- Working on this repo with a coding agent: [AGENTS.md](AGENTS.md)
