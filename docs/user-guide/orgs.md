# Orgs

An org is the top-level group in the console. It owns projects, members, tokens and the audit log. Your apps,
custom domains and usage all belong to an org.

## Create an org

Sign in and choose **New org** from the org switcher. Pick a name and a slug. The slug is part of URLs and cannot be
changed later, so choose it carefully. You become the org's owner.

## Org roles

| Role | Can |
|---|---|
| `owner` | Everything an admin can, plus manage owners, delete the org, and rotate the default key |
| `admin` | Manage members and their roles (except owners), and manage tokens |
| `member` | See the org and the projects it has granted them. Can do what their project grants allow |

Org roles set the ceiling. A member's access inside a project is set by a project grant (see
[Members](members.md)).

Each org has at least one owner. The console refuses any change that would remove the last owner.

## Usage and quotas

The org page shows the usage of its apps against the plan's limits. When a limit is reached, the console says so
and blocks the action that would exceed it. The plan is assigned by the instance (see the [admin guide](../admin-guide.md)).

## Delete an org

Only an owner can delete an org. An org must be empty first: remove its apps, projects and domains. Deleting an org
cannot be undone.
