# Tokens and keys

Tokens let people and services call the Runtime Web API and the runtime without a browser session. Each org has a
default key and can have any number of custom tokens.

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

Custom tokens cannot mint keys. Tokens are org-level in this version: only owners and admins can create, list and revoke
them.

## Create and revoke

1. Open **Settings > Tokens** in the org.
2. Create a token, give it a name, pick its scopes, and optionally set an expiry.
3. Copy the token. The secret is shown once, when the token is created. The list shows the token's name and metadata,
   never the secret.
4. To revoke a token, remove it from the list. Anything that still uses it stops working.

Never commit a token to source control. Keep it in your secret store and pass it to your tools as an environment variable.
