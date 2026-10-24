# Runtime Web

Runtime Web is a self-hosted console for writing, deploying and running small apps on
[21 Cloud Runtime](https://github.com/21-ci/runtime). It is what you use in the browser: sign up, make an org and a
project, write an app, watch its logs, give it a route or a domain, and hand out a token to the people and services
that need one.

Everything the console does goes through the runtime's API, so anything you can do here you can also script.

## Where to go next

<div class="grid cards" markdown>

- **Install**

    Run the console and a runtime node with Docker Compose.

    [:octicons-arrow-right-24: Install](getting-started/install.md)

- **Use the console**

    Orgs, projects, apps, the editor, logs, triggers, tokens, domains and members.

    [:octicons-arrow-right-24: User guide](user-guide/index.md)

- **Run an instance**

    First run, instance admin, upgrades and backups.

    [:octicons-arrow-right-24: Admin guide](admin-guide.md)

- **Check the model**

    Trust boundaries, sessions, authorization and what is not protected.

    [:octicons-arrow-right-24: Security model](security-model.md)

- **Call the API**

    Every HTTP route the console exposes, with its auth rules.

    [:octicons-arrow-right-24: HTTP API](reference/api.md)

- **Contribute**

    Dev setup, make targets, tests and code style.

    [:octicons-arrow-right-24: Contributing](contributing/index.md)

</div>

## Concepts in one minute

- **Org**: the top-level group. Members belong to an org and have an org role.
- **Project**: a folder of apps inside an org. Members get access to a project through grants.
- **App**: a unit of your code. It has versions, a config (env vars and secrets), schedules, a queue, logs and
    optionally custom domains.
- **Token**: a credential with explicit scopes that a person or a service uses to call the API.

## Status

Runtime Web is pre-1.0. The HTTP API and the configuration keys may change between minor versions. Breaking changes
are listed in the [changelog](https://github.com/21-ci/runtime-web/blob/main/CHANGELOG.md).
