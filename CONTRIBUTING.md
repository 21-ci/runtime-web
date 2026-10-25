# Contributing

Thanks for helping. This page covers the ground rules, the checks a change must pass and how it gets merged. The full
guides are in the [contributing docs](https://21-ci.github.io/runtime-web/contributing/): dev setup, testing, adding an
endpoint or a page, and releases.

Questions go to [Discussions](https://github.com/21-ci/runtime-web/discussions). Security bugs go through
[SECURITY.md](SECURITY.md), never a public issue.

## Ground rules

- Open an issue or a discussion before a large change, so the design is agreed before the code.
- One logical change per pull request. Small pull requests are reviewed faster.
- Cover the main logic with tests: request paths, authorization rules, limits and user-visible errors.
- User-visible behavior changes together with its docs: the [HTTP API reference](docs/reference/api.md), the
  [configuration reference](docs/reference/configuration.md) and the user guide.
- Changes that touch a trust boundary (sessions, CSRF, authorization, secrets, domains, the `rtctl` SDK and bindings,
  the Caddy relay) also update [SECURITY.md](SECURITY.md) or the [security model](docs/security-model.md), and ask for
  a security-aware review.
- Commit messages and pull request titles use [Conventional Commits](https://www.conventionalcommits.org): `feat:`,
  `fix:`, `docs:`, `chore:`, and `feat!:` for a breaking change.
- Contributions are accepted under the Apache License 2.0 (see [LICENSE](LICENSE)).

## Quick start

You need Node.js 22.5 or newer and GNU make.

```bash
git clone https://github.com/21-ci/runtime-web && cd runtime-web
make ci          # installs dependencies, builds, lints and tests the console and the server
```

`make help` lists every target. The full dev setup, including a live deploy to a local runtime node, is in
[Dev setup](https://21-ci.github.io/runtime-web/contributing/dev-setup/).

Before you open a pull request, run the checks CI runs:

```bash
make ci && make coverage
```

## Tests

- Run the narrowest test that covers your change while you work, for example
  `cd server && npx vitest run test/orgs`. Then run the full chain.
- `server/test/contract.test.ts` fails when a route in [`docs/reference/api.md`](docs/reference/api.md) is not
  registered. When you change an endpoint, update that file and the console's MSW handlers in `web/src/test/` in the
  same change.
- Coverage thresholds live in `web/vitest.config.ts` and `server/vitest.config.ts`. Raise them when coverage improves,
  and never lower them. See [Testing and coverage](https://21-ci.github.io/runtime-web/contributing/testing/).

## Adding an endpoint or a page

Follow the project skills in [`.claude/skills/`](.claude/skills/): `add-api-endpoint` for a route and its client hook,
`ui-design` for a console page and its primitives. The
[guide](https://21-ci.github.io/runtime-web/contributing/adding-endpoints-and-pages/) lists the same steps.

## Pull requests

1. Fork the repository, branch from `main`, and keep the branch focused.
2. Make sure `make ci` passes locally.
3. Fill in the description: what changed, why, how you tested it, and any doc or security impact.
4. Expect at least one maintainer review. Code owners review security-sensitive paths.
5. Maintainers merge with a squash commit whose title is the pull request title.

## Releases

Maintainers cut releases as described in [RELEASING.md](RELEASING.md). Contributors do not need to change the version.

## Developer Certificate of Origin

By contributing, you certify that you wrote the change or have the right to submit it under the project license. Sign
your commits with `git commit -s` (`Signed-off-by: Your Name <you@example.com>`) when you can.

## Code style and design

- Code style: [docs/contributing/code-style.md](docs/contributing/code-style.md). It is binding.
- Design tokens and the look of the console: [docs/contributing/design-tokens.md](docs/contributing/design-tokens.md)
- Working on this repository with a coding agent: [AGENTS.md](AGENTS.md)
