# Install

This page runs the full stack on one machine for evaluation or development: a 21 Cloud Runtime node, the console and
the router, with Docker Compose. For a production instance, read the [admin guide](../admin-guide.md) and the
[security model](../security-model.md) first.

## Requirements

- Docker with Compose v2
- A checkout of this repository, and of the [21 Cloud Runtime](https://github.com/21-ci/runtime) repository for the
  node image (the compose file builds it from `RUNTIME_SRC`)
- About 2 GB of free disk for the images

## Steps

1. Clone the repository and copy the example environment file:

    ```bash
    git clone https://github.com/21-ci/runtime-web
    cd runtime-web
    cp .env.example .env
    ```

2. Set the runtime node location in `.env` if the runtime checkout is not next to this one (`RUNTIME_SRC`).

3. Start the stack and wait until the runtime reports healthy:

    ```bash
    docker compose up -d --build --wait
    ```

4. Open the console:

    ```text
    http://console.localhost:8080
    ```

    On a clean volume the console shows the first-run setup page. Continue with [First run](../admin-guide.md#first-run).

5. Stop the stack when you are done. The data volumes are kept:

    ```bash
    docker compose down
    ```

    Add `-v` to delete the data as well.

!!! note "One-line installer"
    A one-line installer (`curl -fsSL https://raw.githubusercontent.com/21-ci/runtime-web/main/install.sh | sh`) is
    planned for the first release. It is not published yet, so use the steps above.

## What runs

| Service | Role | Published on |
|---|---|---|
| `runtime` | 21 Cloud Runtime node: runs apps, storage, schedules, queues | loopback only, for direct app URLs |
| `rtweb` | console API and single-page app | compose network only |
| `rtrouter` | routes the console host, `{app}.{BASE_DOMAIN}` and custom domains | `127.0.0.1:${ROUTER_HTTP_PORT}` |

Only the router is reachable from your browser. Every other service stays on the compose network.

## Next steps

- [Configuration](../configuration.md): every variable in `.env`
- [First run](../admin-guide.md#first-run): create the first instance admin
- [Orgs](../user-guide/orgs.md) and [Apps](../user-guide/apps.md): your first app
