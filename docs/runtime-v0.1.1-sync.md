# Runtime v0.1.1 sync

Runtime Web was built against runtime snapshot `b52766e`. This note lists the public control API changes in
runtime v0.1.1 (`bc97aa8`, `github.com/21-ci/runtime`), from a diff of `openapi/openapi.json`, `docs/api.md`
and `crates/rt-api`. Internal-only changes are left out.

## Breaking

- **Key restriction by project, not service.** `CreateKeyBody`, `CreateTokenBody`, `KeyView` and `MeView`
  drop `service_ids` and gain `project_ids` (`prj_…`) and `environments`. `null` means all; an explicit `[]`
  means none. A child key can only narrow its parent. A service outside the key's projects or environments
  is `404`.
  - Web: custom tokens now take `projects` (project slugs) and `environments` instead of `apps`
    (`docs/api-web.md` §7). The `tokens.apps` column becomes `tokens.projects`, plus a new
    `tokens.environments` column (migration `0006`).
- **`ServiceView` adds required `project_id` and `durable`.** Clients that decode it strictly must accept them.
- **`NodeStatus` adds required `sockets: {open, objects, pending, max}`.**
- **Error codes:** `reserved` (403, the system tenant); `sdk_release_exists` (409); `storage_quota` and
  `egress_quota` (413); `sql_error`, `sql_not_authorized`, `sql_result_too_large`, `kv_not_integer`,
  `kv_overflow`, `missing_export`, `no_rpc_surface`, `sdk_*` (422); `sql_busy` and `sql_timeout` (503).
  Every route now also documents `403` and `429 rate_limited` (with `Retry-After`). Version uploads over the
  node's 4 concurrent buffers get `429 rate_limited`.

## New

- **New scope `sockets:write`**, for closing WebSockets. It is added to the org default key's scopes.
- **Log fields.** `LogView.fields` holds the structured fields of a `std:log` record. It is absent on plain
  records.
- **One-off schedules.** `GET /v1/services/{s}/schedules/once?limit&cursor` returns
  `{items: [{id, kind: "once", run_at}], next_cursor}`.
- **WebSockets and durable objects.** Services gain `durable` and
  `ws: {allowed_origins, warm, max_sockets}` (on create and patch). New routes:
  `GET /v1/services/{s}/objects`, `DELETE /v1/services/{s}/objects/{name}`,
  `GET|DELETE /v1/services/{s}/objects/{name}/sockets` and
  `DELETE /v1/services/{s}/objects/{name}/sockets/{ws}`. `SetLiveBody.close_sockets` and the version upload
  query `close_sockets` close open sockets with code 1012 once the version goes live.
- **RPC types.** `GET /v1/services/{s}/types?version=` returns the `.d.ts` of a Deno service's `rpc` export.
- **Operator SDKs.** `GET|POST /v1/sdks`, `GET /v1/sdks/{name}/releases`,
  `PUT /v1/sdks/{name}/channels/{channel}`, `DELETE /v1/sdks/{name}`, `GET|PUT /v1/sdk-grants` (operator
  only). For tenants: `GET /v1/sdks/effective?project&environment` and `GET /v1/sdks/{name}/contract`.
- **MCP** now has 26 tools, adding SDKs, sockets and objects.

## Done in Runtime Web

- Client, fake and keys service use `project_ids` and `environments`. The token form picks projects and
  environments.
- `Service` decodes `project_id`, `durable` and `ws`. `NodeStatus` decodes `sockets`.
- The live log stream and build logs pass `fields` through. The logs view shows them as JSON.
- `GET /api/orgs/{org}/apps/{app}/schedules/once` and a "One-off tasks" list in the schedules panel.

## Deferred

- SDK admin page (publish, channels, grants) and the per-project "Available SDKs" panel.
- Objects and WebSocket inspector, close-socket actions, and the `durable` and `ws` settings in app settings.
- `close_sockets` on promote.
- RPC `.d.ts` editor autocompletion (`/types`, `/sdks/{name}/contract`).
- Mapping the new 413, 422 and 503 data error codes to specific UI copy. They show the generic error toast.
