# Triggers

A trigger is anything that starts your app: an HTTP request, a schedule, or a message on the app's queue. The triggers
page lists all three for one app.

## HTTP routes

Every app has an address:

```text
https://<runtime public host>/s/<app>/
```

Requests to that address, and to any path below it, go to the app's handler. If the app has a custom domain, the same
app also answers on that host (see [Domains](domains.md)).

Access to an app is set in the app's settings. By default, only people and tokens with access can call it.

## Schedules

A schedule runs the app on a timer. Each schedule has:

- a name,
- a cron expression or a fixed interval,
- a time zone for cron expressions,
- an enabled flag.

The page shows the next runs. Pending one-off tasks that the app scheduled from its own code are listed read-only.
Creating a schedule is refused when it would exceed the plan's schedule limit.

## Queue

Each app has a durable queue. Producers push messages with `POST` on the queue, optionally with a delay or a dedup
key. The app's consumer takes messages from the queue.

- **Depth**, **in flight** and **oldest age** show the queue's health.
- A message that keeps failing is retried, then moves to the **dead-letter queue** (DLQ). The DLQ page lists each message
  with its attempts and the time it failed. You can inspect the messages there.
- A full queue refuses new messages with a `queue_full` error. Raise the app's limit or drain the queue.
