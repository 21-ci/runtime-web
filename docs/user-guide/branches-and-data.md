# Branches, data and alerts

These features help you try changes safely, look at an app's data and hear about problems. The exact routes and errors
are in the [API reference](../reference/api.md).

## Branches and switches

A branch is a staging copy of an app, with its own URL, data and secrets. Deploy to it, try it, then switch.

A switch makes the branch's live build the app's live version. The app keeps its own env, secrets and data. The previous
version finishes what it is running, and the console shows the progress. Before you confirm, a preflight lists the
env names missing on the app, the trigger differences and any pending migrations. It shows names only, never values.

Each switch can be rolled back from its history, as long as the earlier version still exists. Deploying and switching
need the project `developer` role.

## Previews

If you turn previews on for an app's [git link](git.md), each pull request gets its own temporary service. An app can
have 5 at a time. A preview is removed when the pull request closes, and after 7 days at most.

A preview's env comes from the app's preview env, never from production. A pull request from a fork waits until a project
admin approves that commit, and each new commit waits again.

## Data browser

The data browser shows an app's SQL tables, KV entries and blob metadata, and runs read-only SQL queries. It is for
project admins, and each read is recorded in the audit log, without the values.

## Bundles

A bundle holds an app's settings, env values, data, blobs and sources, but no secrets. Export one to move or copy an
app, or import one, or fork another app, to create a new app. Set the secrets again afterwards. Bundles in the console are
limited in size; larger ones need `21ci app export` and `21ci app import`.

## Alerts

Org owners and admins set alerts for high error rates, growing dead-letter queues and failed builds. An alert goes to a
webhook or a Telegram chat. Add a channel, send a test, then add a rule. An alert fires after its condition holds for
5 minutes by default, repeats every 4 hours, and can be muted.

Webhooks are signed: check `X-Rtweb-Signature`, and use `X-Rtweb-Delivery` to drop duplicates. Instance admins also
have alerts for low disk and stale backups.
