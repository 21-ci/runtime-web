# Contributing

Thanks for helping. These pages cover the dev setup and the rules a change follows. The short version is in
[CONTRIBUTING.md](https://github.com/21-ci/runtime-web/blob/main/CONTRIBUTING.md).

- [Architecture](architecture.md): the backend as a service on the runtime, its storage, SDK and edge
- [Code style](code-style.md): the rules for the server and the console
- [CI and releases](ci-cd.md): workflows, coverage gates, signed releases and the installer
- [Design tokens](design-tokens.md): colors, shapes, type and motion used by the console

## Dev loop

```bash
make ci                        # web build/lint/tests/budgets, server typecheck/lint/tests
make coverage                  # both suites with coverage thresholds
make server-deploy             # optional: dev deploy to a local runtime node (needs RT_ROOT_TOKEN)
```

`make help` lists every target. Coding agents read [AGENTS.md](https://github.com/21-ci/runtime-web/blob/main/AGENTS.md).

## Pull requests

Keep one logical change to a PR, and link the issue it closes. Update the HTTP reference and the user docs when behaviour
changes. Security-sensitive changes need a reviewer from the security group. See
[SECURITY.md](https://github.com/21-ci/runtime-web/blob/main/SECURITY.md) for private reports.
