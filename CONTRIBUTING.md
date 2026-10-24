# Contributing

Thanks for helping. This guide covers the dev setup, the checks a change must pass, and how a change gets merged.
Questions go to [Discussions](https://github.com/21-ci/runtime-web/discussions). Security bugs go through
[SECURITY.md](SECURITY.md), never a public issue.

## Ground rules

- Open an issue or a discussion before a large change, so the design is agreed before the code.
- One logical change per PR. Small PRs are reviewed faster.
- Cover the main logic with tests: request paths, authorization rules, limits, user-visible errors. Use the helpers in
  existing `*_test.go` and `web/src/test/` files.
- User-visible behaviour (HTTP API, config keys, limits, UI copy that documents a rule) changes together with its docs.
  The API reference is [`docs/reference/api.md`](docs/reference/api.md); the config reference is
  [`docs/configuration.md`](docs/configuration.md).
- Changes that touch a trust boundary (sessions, CSRF, authorization, secrets, domains, the router) also update
  [SECURITY.md](SECURITY.md) or the security model docs, and ask for a security-aware review.
- Commit messages and PR titles use [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`,
  `docs:`, `chore:`, `feat!:` for a breaking change).
- Contributions are accepted under the Apache License 2.0 (see [LICENSE](LICENSE)).

## Dev setup

| Need | Why |
|---|---|
| Docker with Compose v2 | the full stack: 21 Cloud Runtime node, console, router |
| Node.js (version in `web/package.json` engines or `.nvmrc`, if present) | the console (`web/`): npm, Vite, Vitest |
| GNU make | every task below is a `make` target |
| Python 3.10+ | the docs site (`docs/requirements.txt`) |
| optional: `gitleaks`, `shellcheck` | what a local pre-commit check would run |

```bash
git clone https://github.com/21-ci/runtime-web && cd runtime-web
cp .env.example .env
make web          # install web dependencies and build the console
docker compose up -d --build --wait
```

Open `http://console.localhost:8080` and complete first-run setup. The dev values in `.env.example` are placeholders,
and `RTWEB_DEV=1` accepts them. Never reuse them outside local development.

## Make targets

`make help` lists all of them. The ones you need daily:

| Target | Does |
|---|---|
| `make build` | build the `rtweb` binary into `bin/` (embeds the console) |
| `make test` | run the server tests |
| `make web-test` | run the console tests (Vitest, Testing Library, MSW) |
| `make web-lint` | ESLint and TypeScript checks for the console |
| `make fmt` / `make fmt-check` | format / fail on unformatted files |
| `make ci` | the full CI chain: format check, vet, tests, vulnerability scan, web lint and tests, build, budgets |
| `make e2e` | start the compose stack and run the Playwright smoke suite |
| `make docker` | build the `rtweb` and `rtrouter` images |

## Tests

Run the narrowest test that covers your change while iterating, then the full chain before you push:

```bash
make test                 # server packages
make web-test            # console
make e2e                 # black-box smoke against docker compose (needs Docker)
```

The console's tests mock the API with MSW. When you change an endpoint, update the mock handlers under `web/src/test/`
in the same PR.

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
