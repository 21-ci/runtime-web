# Logs

The logs page shows what an app prints and what the runtime records for it, as it happens.

## Live stream

The page opens a live stream over Server-Sent Events. New lines appear as the app writes them. If the connection drops,
the console reconnects.

## Level filter

Show only lines at or above a level: `debug`, `info`, `warn` or `error`.

## Stats

The app page shows the runtime's stats for the app over a window of 5 minutes, 1 hour or 24 hours. The numbers come from
the runtime and are approximate.

## Access

Anyone with read access to the app can see its logs. Logs contain whatever your code prints, so do not log secrets.
