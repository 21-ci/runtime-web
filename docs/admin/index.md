---
title: Admin guide
description: Run a Runtime Web instance day to day: the instance admin console, account recovery and where the operations pages are.
---

# Admin guide

This guide is for the person who runs an instance. It covers the instance admin console and account recovery. For the
node, domains, backups and upgrades, see [Operations](operations.md). Settings are listed in
[Configuration](../reference/configuration.md).

Setting up a new instance comes first: [Install](../getting-started/install.md), then
[First run](../getting-started/first-run.md).

## Instance admin console

Instance admins see an **Instance** group in the console sidebar, under Projects, and the same pages in the ⌘K menu.
The pages open in the normal console, with the org switcher and projects still in place.

| Page | Use it to |
|---|---|
| Users | Find users, disable or enable accounts, and manage their access |
| Orgs | Find orgs and see their members, plans and usage |
| Invites | Invite people to the instance, and see pending invites |
| Node | See the runtime node's status and its scheduler |
| Cache | See the runtime's artifact cache |
| Domains | See every custom domain on the instance and its verification state |
| Settings | Instance policy, for example whether two-factor auth is required and which sign-in providers are enabled |
| Audit | Search the instance-wide audit log |

Admin actions that change state are written to the audit log. Review it on a schedule.

## Account recovery

When someone loses their authenticator and their recovery codes, an instance admin can remove their second factor from
**Instance → Users**, which calls `DELETE /api/admin/users/{id}/totp`. An admin can also reset a password, which forces
a change at the next sign-in. Both actions are audited.

## Where to next

- [Operations](operations.md): the runtime node, custom domains and TLS, backups and keys, upgrades, and the security checklist
- [Security model](../security-model.md): what is protected and what is not
- [Branding](branding.md): white-label branding for the console
- [Languages](languages.md): interface languages
