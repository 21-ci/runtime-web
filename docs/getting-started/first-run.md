---
title: First run
description: Finish a new Runtime Web install by creating the instance admin account, then remove the setup token.
---

# First run

The installer ends with a one-time setup token. You use it once, on the setup page, to create the first account. That
account becomes the instance admin, and setup creates your first org for it.

Before you start, have the setup token from the installer output. If you closed the terminal without copying it, see
[Lost setup token](#lost-setup-token).

## Create the instance admin

1. Open the setup page of your console:

    ```text
    https://console.example.com/setup
    ```

    The page asks for the setup token. Once an account exists, the setup page no longer creates accounts.

2. Paste the setup token.

3. Enter your name, your e-mail address and a password. The password must be between 12 and 1024 characters.

4. Submit the form. You are signed in as the instance admin.

5. Turn on two-factor authentication for your account at once. See [Two-factor auth and OAuth](../user-guide/two-factor-and-oauth.md).

!!! note

    Setup can run only once per database. A second attempt returns `409 already_set_up`.

## Remove the setup token

The token has no use after setup, so remove its secret. You need the root token and the ids of the tenant and the
service. Run these as root on the host:

```bash
set -a; . /etc/default/rt; set +a
export RT_API=http://127.0.0.1:8081
TENANT_ID=$(curl -fsS "$RT_API/v1/tenants?limit=100" -H "Authorization: Bearer $RT_ROOT_TOKEN" \
  | jq -r '.items[] | select(.name == "runtime-web") | .id')
SVC_ID=$(curl -fsS "$RT_API/v1/services?slug=rtweb" -H "Authorization: Bearer $RT_ROOT_TOKEN" \
  -H "x-rt-tenant: $TENANT_ID" | jq -r '.items[0].id')
curl -fsS -X DELETE "$RT_API/v1/services/$SVC_ID/secrets/RTWEB_SETUP_TOKEN" \
  -H "Authorization: Bearer $RT_ROOT_TOKEN" -H "x-rt-tenant: $TENANT_ID"
```

## Lost setup token

Before setup is complete, you can issue a new token. Delete the old secret with the commands above, then run the
installer again with the same options. It creates a new token and prints it once. Installer runs never reissue a token
while the secret exists, so the delete step is required.

After setup is complete the token no longer matters, and a new one cannot be used to create accounts.

## Next steps

- [Orgs](../user-guide/orgs.md) and [Projects](../user-guide/projects.md): organize your team's work
- [Members](../user-guide/members.md): invite people
- [Admin guide](../admin/index.md): the instance console and account recovery
- [Operations](../admin/operations.md): backups, keys and upgrades
