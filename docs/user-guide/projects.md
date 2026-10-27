# Projects

A project groups apps inside an org. Access is granted per project, so a project is also the unit you share.

## Create a project

Open the org and choose **New project**. Give it a name and a slug. The creator is the first project admin.

## Project roles

| Role | Can |
|---|---|
| `admin` | Full access to the project, including its members' project roles |
| `developer` | Work on the project's apps: code, deploys, config and triggers |
| `viewer` | Read the project's apps, logs and config, except env values |

Org owners and admins act as project admins in every project. Instance admins can act in any org, and their actions
are marked in the audit log.

## Environments

Each app belongs to an environment inside its project. Environments separate apps that share a name but have different
purposes, such as `production` and `staging`. The app's address includes its environment, so choose names that will
make sense in a URL.

## Rename or delete

Project admins can rename a project. A project can be deleted only after its apps are deleted.
