---
title: Runtime Web
description: A self-hosted console for writing, deploying and running apps on 21 Cloud Runtime.
---

# Runtime Web

Runtime Web is a self-hosted console for writing, deploying and running small apps on
[21 Cloud Runtime](https://github.com/21-ci/runtime). Sign up, create an org and a project, write an app, watch its
logs, give it a route or a domain, and hand out a token to the people and services that need one.

Everything the console does goes through the runtime's API, so anything you can do here you can also script.

## Where to go next

<div class="grid cards" markdown>

- **Install**

    Install the console as an App on a 21 Cloud Runtime node with one script, or onto a node you already run.

    [:octicons-arrow-right-24: Install](getting-started/install.md)

- **Use the console**

    Orgs, projects, apps, the editor, logs, triggers, tokens, domains and members.

    [:octicons-arrow-right-24: User guide](user-guide/index.md)

- **Run an instance**

    The instance admin console, account recovery, backups, domains and upgrades.

    [:octicons-arrow-right-24: Admin guide](admin/index.md)

- **Fix a problem**

    Health checks, logs, and the common install and runtime failures with their fixes.

    [:octicons-arrow-right-24: Troubleshooting](troubleshooting.md)

- **Call the API**

    Every HTTP route the console exposes, with its auth rules and errors.

    [:octicons-arrow-right-24: HTTP API](reference/api.md)

- **Contribute**

    Dev setup, make targets, tests, coverage and how to add an endpoint or a page.

    [:octicons-arrow-right-24: Contributing](contributing/index.md)

</div>

## Concepts in one minute

- **Org**: the top-level group. Members belong to an org and have an org role.
- **Project**: a folder of apps inside an org. Members get access to a project through grants.
- **App**: a unit of your code. It has versions, a config (environment variables and secrets), triggers, logs and
  optionally custom domains.
- **Token**: a credential with explicit scopes that a person or a service uses to call the API.

## Status

Runtime Web is pre-1.0. The HTTP API and the configuration keys may change between minor versions. Breaking changes
are listed in the [changelog](https://github.com/21-ci/runtime-web/blob/main/CHANGELOG.md).
