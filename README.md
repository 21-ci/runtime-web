<p align="center">
  <img src="docs/assets/screenshot.png" alt="Runtime Web console: an app's code editor, logs and triggers" width="880">
</p>

<p align="center">
  <a href="https://21-ci.github.io/runtime-web/"><img alt="Docs" src="https://img.shields.io/badge/docs-21-ci.github.io-4f7cff"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
</p>

<p align="center">
  <b>A self-hosted console for writing, deploying and running small apps on 21 Cloud Runtime.</b><br>
  Think val.town, but on a runtime you run yourself: one place for users, orgs, projects, apps, logs, triggers,
  tokens and domains.
</p>

<p align="center">
  <a href="https://21-ci.github.io/runtime-web/">Docs</a> ·
  <a href="#quick-install">Quick install</a> ·
  <a href="#development">Development</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="https://github.com/21-ci/runtime">21 Cloud Runtime</a>
</p>

---

## Why

[21 Cloud Runtime](https://github.com/21-ci/runtime) runs tenant code safely and densely, but a runtime is an API,
not a product. Writing an app means a repo, a deploy command, a token, a log tail and a domain. Runtime Web puts all
of that in one browser console, for your team, on your own machine or cluster.

It is the human side of the runtime. Everything the console does goes through the runtime's API, so anything you can
click here you can also script.

## Features

| | |
|---|---|
| **Orgs, projects, members** | Organizations with owner, admin and member roles; projects inside an org; per-project admin, developer and viewer roles for each member |
| **Apps** | Create an app from a template, edit its code, see its version history and roll back, read its settings (limits, scaling, ingress and egress rules, access) |
| **Editor** | In-browser TypeScript editor with type checking against the runtime's guest API, a file tree and save with conflict detection |
| **Logs** | Live log stream over Server-Sent Events, filtered by level, with per-app stats |
| **Triggers** | HTTP routes, interval and cron schedules, and the app's durable queue with its dead-letter queue, all managed from one page |
| **Config** | Environment variables, write-only secrets, and the rules that decide who can call an app |
| **Tokens** | Default org keys plus scoped custom tokens, shown once on creation and never again |
| **Domains** | Custom domains with DNS TXT verification, mapped to apps through the router, with TLS through the router (ACME) |
| **Security** | Password login with TOTP two-factor auth, GitHub, Google and generic OIDC sign-in, session and CSRF protection, org-scoped audit log |
| **Admin** | Instance admin console: users, orgs, invites, runtime node status, cache, instance settings, domains and audit |

## Quick install

> The installer and release artifacts are not published yet. This is the path they will take.

```bash
curl -fsSL https://raw.githubusercontent.com/21-ci/runtime-web/main/install.sh | sh
```

The installer starts the console next to a 21 Cloud Runtime node. Set the secrets it asks for, then open the console
URL it prints and complete first-run setup. Full steps: [Install](https://21-ci.github.io/runtime-web/getting-started/install/).

## Architecture

```
browser ──► router ──► console (SPA + API) ──► 21 Cloud Runtime (control API)
              │                 │
              └── app hosts ────┴── runtime public listener
```

- **Console**: a React single-page app and its JSON API. The API backend runs as an App on 21 Cloud Runtime.
- **Router**: sends the console host, `{app}.{base domain}` and custom domains to the right place, and terminates TLS.
- **Runtime**: runs the apps, owns their code, storage, schedules and queues, and enforces limits.

Trust boundaries and the security model: [Security model](https://21-ci.github.io/runtime-web/security-model/).

## Development

You need Docker with Compose v2, Node.js (for the web console) and GNU make. Dev quickstart with the full stack:

```bash
cp .env.example .env            # dev values: every dev-insecure-* secret is for local use only
docker compose up -d --build --wait
open http://console.localhost:8080
```

On a clean volume the console opens the setup page. The `make` targets cover the rest:

```bash
make help        # list targets
make ci          # the checks CI runs: format, vet, tests, build, budgets
make web-test    # console tests (Vitest)
make build       # build the rtweb binary into bin/
```

Configuration reference: [Configuration](https://21-ci.github.io/runtime-web/configuration/). Local docs preview:

```bash
pip install -r docs/requirements.txt
mkdocs serve
```

For agents and contributors, read [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [User guide](https://21-ci.github.io/runtime-web/user-guide/): orgs, projects, apps, editor, logs, triggers, tokens,
  domains, members, two-factor auth and OAuth
- [Admin guide](https://21-ci.github.io/runtime-web/admin-guide/): first run, users, runtime node, domains, audit
- [Security model](https://21-ci.github.io/runtime-web/security-model/)
- [HTTP API reference](https://21-ci.github.io/runtime-web/reference/api/)
- [Contributing](https://21-ci.github.io/runtime-web/contributing/)

## Community

- Bugs and feature requests: [GitHub issues](https://github.com/21-ci/runtime-web/issues)
- Questions and ideas: [Discussions](https://github.com/21-ci/runtime-web/discussions)
- Security problems: [SECURITY.md](SECURITY.md), never a public issue
- Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## License

Apache License 2.0. See [LICENSE](LICENSE).
