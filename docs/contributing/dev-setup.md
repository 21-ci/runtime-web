---
title: Dev setup
description: Clone Runtime Web, run its checks, and deploy a change to a local runtime node.
---

# Dev setup

This page gets a checkout to a state where `make ci` passes. Both test suites run without a runtime node. A node is only
needed to see a change running in the console.

## Requirements

| Tool | Why |
|---|---|
| Node.js 22.5 or newer, with npm | The console (`web/`) and the backend (`server/`). The server tests use `node:sqlite` |
| GNU make | Every task is a `make` target |
| Python 3.10 or newer | The docs site (`docs/requirements.txt`) |
| A local 21 Cloud Runtime node | Optional. Needed for `make server-deploy`, `make server-install` and `make e2e` |
| `shellcheck`, `actionlint`, `gitleaks` | Optional. CI runs them on `install.sh`, the workflows and the secrets |

## Steps

1. Clone the repository and go to the checkout:

    ```bash
    git clone https://github.com/21-ci/runtime-web
    cd runtime-web
    ```

2. Run the CI chain. It installs the dependencies of `web/` and `server/`, builds the console, and runs the lints,
   type checks, tests and bundle budgets:

    ```bash
    make ci
    ```

3. Check that the docs build. CI runs this with `--strict`, so any warning fails the build:

    ```bash
    python3 -m venv .venv
    .venv/bin/pip install -r docs/requirements.txt
    .venv/bin/mkdocs build --strict
    ```

    Use `.venv/bin/mkdocs serve` for a live preview at `http://127.0.0.1:8000`.

4. Optional: deploy to a local node. Copy the environment template, replace the `dev-insecure-*` placeholders with
   values for your node, and load it:

    ```bash
    cp .env.example .env
    set -a; . ./.env; set +a
    make server-deploy
    ```

    `make server-deploy` builds the console into the server and uploads a new version of the `rtweb` service. It needs
    `RT_ROOT_TOKEN` and does not change the node's configuration. A node that has never had the console needs the plan
    and bindings first: use `make server-install` after following [Manual install](../getting-started/manual-install.md).

    The `dev-insecure-*` values are placeholders for local use only. Never reuse them on a real node.

5. Run the console with its dev server while you work on the UI. See
   [Troubleshooting: Run the console and the tests locally](../troubleshooting.md#run-the-console-and-the-tests-locally).

## Make targets

`make help` lists every target. These are the ones you use every day:

| Target | Does |
|---|---|
| `make ci` | The CI chain: web build, lint, tests and gzip budgets; server typecheck, lint and unit tests |
| `make coverage` | Web and server tests with v8 coverage and thresholds |
| `make web` | Install web dependencies (`npm ci`) and build the console into `web/dist` |
| `make web-test` | Console tests (Vitest, Testing Library, MSW) |
| `make web-lint` | ESLint and the TypeScript check of the console |
| `make web-audit` | Fail on high-severity npm advisories in `web/` |
| `make server-deps` | Install server dependencies |
| `make server-assets` | Build `web/dist` and embed it as `server/src/gen` (generated, git-ignored) |
| `make server-test` | Server unit tests (Vitest) |
| `make server-ci` | Server typecheck, lint and unit tests |
| `make server-deploy` | Dev deploy of `server/` to a local node (needs `RT_ROOT_TOKEN`) |
| `make server-install` | Idempotent install onto a node (needs `RT_ROOT_TOKEN`) |
| `make budget` | Gzip budgets of `web/dist`. With `RTWEB_URL`, also the service health |
| `make e2e` | Playwright smoke suite against a runtime-hosted console (needs `RTWEB_URL`) |
| `make clean` | Remove test reports and the generated server assets |

## Next steps

- [Testing and coverage](testing.md)
- [Adding an endpoint or a page](adding-endpoints-and-pages.md)
- [Architecture](architecture.md)
