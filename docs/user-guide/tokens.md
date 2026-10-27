# Tokens and keys

Tokens let scripts, CI and agents call the runtime and the console's app API without a browser session. Each org has
a default key and can have any number of custom tokens.

## Default key

Every org has a default key. It holds every scope, and it is the key that automation uses by default.

- **Rotate** replaces the default key with a new one. Custom tokens keep working. Update anything that still uses the
  old default key.
- Only owners and admins can rotate it.

## Custom tokens

A custom token carries only the scopes you pick. Use one per service, so that a leaked token can be revoked without
touching anything else.

| Scope | Allows |
|---|---|
| `services:read` | Read apps, versions and config |
| `logs:read` | Read logs |
| `services:write` | Create and change apps |
| `deploy` | Deploy versions |
| `env:write` | Change environment variables |
| `queue:write` | Send messages to an app's queue |
| `invoke` | Call an app's HTTP routes |
| `secrets:write` | Set and delete secrets |
| `data:admin` | Manage an app's stored data |
| `sockets:write` | Open WebSocket connections |

Custom tokens cannot mint keys. A custom token can be limited to some projects and some environments. Leave
either list empty to allow all of them. Tokens are org-level in this version: only owners and admins can create, list and revoke
them.

## Create and revoke

1. Open **Settings > Tokens** in the org.
2. Create a token, give it a name, pick its scopes, and optionally set an expiry.
3. Copy the token. The secret is shown once, when the token is created. The list shows the token's name and metadata,
   never the secret.
4. To revoke a token, remove it from the list. Anything that still uses it stops working.

Never commit a token to source control. Keep it in your secret store and pass it to your tools as an environment variable.

## Call the console API

A custom token can manage apps through the console API with `Authorization: Bearer <token>`:

```sh
curl -H "Authorization: Bearer $RTWEB_TOKEN" https://console.example.com/api/orgs/acme/apps/hello/logs
```

- Only the app routes accept a token: `/api/orgs/<org>/apps` and everything below it, such as code, versions, env,
  secrets, schedules, queue and logs. Sign-in, profile, users, members, tokens, admin and settings routes refuse it
  with `403 bearer_not_allowed`.
- The token's scopes decide what it can do: `services:read` reads apps, `services:write` creates, changes and
  deletes them, `deploy` saves code and switches versions, `env:write` reads and changes env, `secrets:write` sets
  secrets, `queue:write` changes queue settings, `logs:read` reads logs and `data:admin` exports data. Custom
  domains need a person in the console.
- An app outside the token's projects or environments gets `403`. A token limited to environments must pass
  `?environment=<name>` when it lists apps.
- Send the token without cookies. A request with both gets `400 ambiguous_credentials`.
- Each token can make 600 requests per minute. Past that, the API answers `429` with `Retry-After`.
- The audit log shows the token's name as the actor of every change it makes.

Tokens created before your console supported this cannot call the console API. Create a new token and revoke the
old one.
