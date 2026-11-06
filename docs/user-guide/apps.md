# Apps

An app is a unit of your code that runs on the runtime. Each app has a template, versions, settings, triggers, logs and
optional custom domains.

## Create an app

1. Open a project and create a new app.
2. Pick an environment, a slug and a template:

    | Template | What it starts with |
    |---|---|
    | `http` | A handler for HTTP requests |
    | `cron` | A scheduled job |
    | `queue` | A consumer for the app's queue |
    | `sqlite-crud` | A small HTTP app backed by an SQLite database |

3. Create the app. The console opens its code page.

The slug is part of the app's address and cannot be changed. Slugs are unique across the runtime, so a slug another
tenant already uses is refused.

## Versions

Saving code creates a version but does not change what is live. Deploying (the **Deploy** button in the editor, or
the versions page) makes a version live. From the versions page you can roll back to an earlier
version. The earlier version becomes live again, and no code is deleted.

![The versions page of an app](../assets/screenshots/versions-light.png#only-light)
![The versions page of an app](../assets/screenshots/versions-dark.png#only-dark)

## Branches

The **Branches** page creates staging copies of an app, each with its own URL, data and secrets. **Switch** makes a
branch's build live on the app, and the switch history below offers **Roll back**.

![A branch and the switch history](../assets/screenshots/branches-light.png#only-light)
![A branch and the switch history](../assets/screenshots/branches-dark.png#only-dark)

The rollback dialog says what stays: data written by the newer version is not undone.

![The rollback dialog](../assets/screenshots/rollback-light.png#only-light)
![The rollback dialog](../assets/screenshots/rollback-dark.png#only-dark)

## Traffic and data

The overview shows requests, errors and latency. The **Data** page reads the app's tables, keys and files; nothing there
can change them, and every read is recorded in the audit log.

![An app's overview with requests and latency](../assets/screenshots/app-overview-light.png#only-light)
![An app's overview with requests and latency](../assets/screenshots/app-overview-dark.png#only-dark)

![The data browser showing a table](../assets/screenshots/data-light.png#only-light)
![The data browser showing a table](../assets/screenshots/data-dark.png#only-dark)

## Settings

The app's settings page groups what the runtime enforces for the app:

| Section | Controls |
|---|---|
| Limits | The runtime limits for the app, within the plan's maximums |
| Scaling | The scaling policy the runtime applies to the app |
| Ingress | Which HTTP methods, path prefixes and client IP ranges may reach the app, and its rate limit |
| Egress | The outbound network rules for the app |
| Access and callers | Who may call the app |
| Danger zone | Deleting the app |

## Delete an app

Project admins can delete an app from the danger zone. Deleting an app also removes its custom domains. Deletion cannot
be undone, so export any data you need first.
