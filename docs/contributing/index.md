# Contributing

Thanks for helping. These pages cover the dev setup and the rules a change follows. The short version is in
[CONTRIBUTING.md](https://github.com/21-ci/runtime-web/blob/main/CONTRIBUTING.md).

- [Code style](code-style.md): the rules for Go and for the console
- [Design tokens](design-tokens.md): colors, shapes, type and motion used by the console

## Dev loop

```bash
cp .env.example .env
make web                       # install and build the console
docker compose up -d --build --wait
make ci                        # what CI runs
```

`make help` lists every target. Coding agents read [AGENTS.md](https://github.com/21-ci/runtime-web/blob/main/AGENTS.md).

## Pull requests

Keep one logical change to a PR, and link the issue it closes. Update the HTTP reference and the user docs when behaviour
changes. Security-sensitive changes need a reviewer from the security group. See
[SECURITY.md](https://github.com/21-ci/runtime-web/blob/main/SECURITY.md) for private reports.
