<p align="center">
  <img src="docs/assets/images/logo.svg" alt="21 Cloud" width="72">
</p>

<h1 align="center">Runtime Web</h1>

<p align="center">
  <a href="https://github.com/21-ci/runtime-web/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/21-ci/runtime-web/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/21-ci/runtime-web/actions/workflows/security.yml"><img alt="Security" src="https://github.com/21-ci/runtime-web/actions/workflows/security.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/21-ci/runtime-web/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/21-ci/runtime-web?sort=semver"></a>
  <a href="https://21-ci.github.io/runtime-web/"><img alt="Docs" src="https://img.shields.io/badge/docs-21-ci.github.io-4f7cff"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
</p>

<p align="center">
  <b>A self-hosted console for writing, deploying and running apps on 21 Cloud Runtime.</b>
</p>

<p align="center">
  <a href="https://21-ci.github.io/runtime-web/">Docs</a> ·
  <a href="#quick-install">Quick install</a> ·
  <a href="#features">Features</a> ·
  <a href="#development">Development</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <img src="docs/assets/screenshot.png" alt="Runtime Web console: the org overview with projects, apps, members and usage" width="880">
</p>

---

## Why

[21 Cloud Runtime](https://github.com/21-ci/runtime) runs tenant code safely and densely, but a runtime is an API, not
a product. Shipping an app means a repository, a deploy command, a token, a log tail and a domain. Runtime Web puts all
of that in one browser console for your team, on your own host.

It is the human side of the runtime. Everything the console does goes through the runtime's API, so anything you can
click here you can also script.

## Features

| | |
|---|---|
| **Orgs, projects, apps** | Orgs with owner, admin and member roles; projects inside an org; per-project admin, developer and viewer roles; apps created from templates, with versions and rollback |
| **Editor** | An in-browser code editor with a file tree, type checking against the runtime's guest API, and save with conflict detection |
| **Env and secrets** | Environment variables, write-only secrets sealed at rest with AES-256-GCM, and per-app ingress and egress rules |
| **Triggers and logs** | HTTP routes, interval and cron schedules, and a durable queue with a dead-letter queue; a live log stream with per-app stats |
| **Domains** | Custom domains with DNS TXT verification, mapped to apps on the runtime, with automatic TLS from Caddy |
| **Tokens** | Default org keys and scoped API tokens, shown once on creation |
| **Security** | Password sign-in with TOTP two-factor auth, GitHub, Google and generic OIDC sign-in, CSRF and Origin checks, and an audit log |
| **Instance admin** | Users, orgs, invites, the runtime node's status, the artifact cache, instance settings, every domain and the instance audit log |
| **Branding** | Built-in white-label branding for the console (coming in this release) |
| **Languages** | Russian and Uzbek interfaces (coming) |

## Quick install

On a Linux host (x86_64 or aarch64) with systemd, Node.js 22.5+ and Caddy:

```bash
curl -fsSL https://raw.githubusercontent.com/21-ci/runtime-web/main/install.sh -o install.sh
sudo sh install.sh --domain console.example.com --email ops@example.com
```

The installer sets up a 21 Cloud Runtime node if `rt` is missing, verifies a signed release, adds the console's plan
and bindings to the node, puts Caddy in front with automatic TLS, and deploys the console as an App on the node. It
prints a one-time setup token. Open `https://<domain>/setup` to create the instance admin account.

Preview the steps without changing the host with `--dry-run`. Remove everything with `--uninstall`. Full steps:
[Install](https://21-ci.github.io/runtime-web/getting-started/install/), then
[First run](https://21-ci.github.io/runtime-web/getting-started/first-run/).

## Architecture

```text
browser ──HTTPS──► Caddy ──► rt invoke listener :8080 ──► rtweb (console API and SPA, an App on the node)
                                                             │
                              binding rtctl-op ──────────────┴──────► rt control API :8081
                              binding rtctl-tenant ──► Caddy relay :8082 ──┘
```

- **Console**: a React single-page app in `web/`, embedded into `server/`, a TypeScript backend that runs as the App
  `rtweb` on 21 Cloud Runtime. Its state lives in the App's SQL database and KV store.
- **Runtime**: runs the apps, owns their code, storage, schedules and queues, maps custom hosts and enforces limits.
- **Caddy**: terminates TLS for the console and for custom domains, and relays tenant-scoped control API calls.

Design: [Architecture](https://21-ci.github.io/runtime-web/contributing/architecture/). Trust boundaries:
[Security model](https://21-ci.github.io/runtime-web/security-model/).

## Development

You need Node.js 22.5+ and GNU make. A local 21 Cloud Runtime node is optional, for a live deploy.

```bash
make help            # list the targets
make ci              # web build, lint, tests and budgets; server typecheck, lint and tests
make coverage        # web and server tests with coverage thresholds
make server-deploy   # dev deploy to a local runtime node (needs RT_ROOT_TOKEN)
make e2e             # Playwright smoke against a hosted console (needs RTWEB_URL)
```

The console's tests run against MSW handlers, and the server's against an in-memory harness, so neither needs a
runtime node. Setup, the day-to-day loop and the test guide are in [Contributing](https://21-ci.github.io/runtime-web/contributing/).

## Documentation

- [Install](https://21-ci.github.io/runtime-web/getting-started/install/) and [manual install](https://21-ci.github.io/runtime-web/getting-started/manual-install/)
- [User guide](https://21-ci.github.io/runtime-web/user-guide/): orgs, projects, apps, the editor, logs, triggers, tokens, domains, members, two-factor auth and OAuth
- [Admin guide](https://21-ci.github.io/runtime-web/admin/): the instance console, operations, backups and upgrades
- [Troubleshooting](https://21-ci.github.io/runtime-web/troubleshooting/)
- [Configuration](https://21-ci.github.io/runtime-web/reference/configuration/) and the [HTTP API](https://21-ci.github.io/runtime-web/reference/api/)
- [Security model](https://21-ci.github.io/runtime-web/security-model/)

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the ground rules and [AGENTS.md](AGENTS.md) if you work with a coding agent.
Commits follow Conventional Commits. Support and questions: [SUPPORT.md](SUPPORT.md).

## Security

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md). Do not open a public issue for them.

## Community

- Bugs and feature requests: [GitHub issues](https://github.com/21-ci/runtime-web/issues)
- Questions and ideas: [GitHub Discussions](https://github.com/21-ci/runtime-web/discussions)
- Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
