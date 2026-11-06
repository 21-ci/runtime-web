---
title: UI guidelines
description: Binding rules for every screen of the console: which components to use, how lists, tables, forms, charts, history views, states, exports, copy, density, responsive layout and themes must behave.
---

# UI guidelines

These rules are binding for every page and component in `web/`. They complement
[Design tokens](design-tokens.md) (colour, type, radius) and [Code style](code-style.md). A pull request that adds or
changes UI is reviewed against this page; a reviewer may quote a rule number.

The console must read like real cloud-provider software: one shell, one set of controls, one way to show a list, a
state or a history. If two screens solve the same problem differently, one of them is wrong.

## 1. Sources of components

The order of preference when a screen needs a control:

1. A primitive in `web/src/components/ui/` (`button.tsx`, `select.tsx`, `table.tsx`, `tabs.tsx`, `badge.tsx`,
   `dialog.tsx`, `sheet.tsx`, `dropdown-menu.tsx`, `tooltip.tsx`, `empty-state.tsx`, `skeleton.tsx`, `stat-tile.tsx`,
   `line-chart.tsx`, `section-card.tsx`, `page-header.tsx`, `icon-tile.tsx`, `key-value-rows.tsx`, `progress.tsx`,
   `toast.tsx`, `confirm-dialog.tsx`, `collapsible.tsx`, `url-bar.tsx`).
2. A component from the owner's library at `/Users/aliakseych/Projects/components` (gallery on
   `http://localhost:5200`, rules in its `AGENTS.md`). Install with `meta.install` when it is set
   (`npx shadcn@latest add <install>`), otherwise copy the folder into `web/src/components/<category>/<slug>/`. The
   library components that map onto console needs:

   | Need | Library path |
   |---|---|
   | Sortable, filterable, paged table | `components/data-display/data-table-01` … `data-table-06`, `components/data-display/table` |
   | Status pill, counter pill | `components/data-display/pill` |
   | Buttons, split and grouped actions | `components/actions/button`, `components/actions/button-group`, `components/actions/dropdown-menu` |
   | Searchable select, tag picker | `components/forms/combobox` |
   | Settings forms, key-value editors | `components/forms/forms-01` … `forms-08`, `components/workspace/settings-01` … `settings-07` |
   | Deploy and version history | `components/operations/deployments-01` … `deployments-04` |
   | Service status, alert rules | `components/operations/status-01` … `status-05`, `components/operations/alerts-01` … `alerts-04` |
   | Activity feeds, audit timelines | `components/workspace/activity-feed-01` … `activity-feed-05` |
   | Members, invites | `components/workspace/team-01` … `team-06` |
   | Sessions, 2FA, tokens | `components/workspace/security-01` … `security-06` |
   | Loading, empty, error page states | `components/dashboard/states-01` … `states-04`, `components/workspace/error-pages-01` … `error-pages-05` |
   | Page and section headers | `components/dashboard/page-header-01` … `page-header-04`, `dashboard-header-01` … `dashboard-header-04` |
   | KPI tiles, sparklines, charts | `components/analytics/stat-group-*`, `metric-list-*`, `chart-panel-*`, `area-chart-kpi-*`, `realtime-*` |
   | Code, diffs, snippets, schema | `components/code/code-block`, `snippet`, `schema-display`, `sandbox` |
   | Command menu, shell, drawer, tree | `components/app-interface/command-menu-*`, `app-shell-*`, `drawer`, `tree` |
   | Onboarding, first run | `components/workspace/onboarding-01` … `onboarding-04` |

3. A new primitive in `web/src/components/ui/`, only when neither source has one, and then with a test in
   `ui-kit.test.tsx` and an entry in this page.

- Do: strip app-specific data, routes and API calls out of a harvested component; wire it to TanStack Query hooks.
- Do: keep the library's `components/ui/` shadcn parts as the only shared parts a copied component may import.
- Don't: write a one-off table, select, list row or badge inside a feature folder.
- Don't: import a second icon set, chart library or table library. Icons are `lucide-react`; tables are the
  `table.tsx` primitive or a library data-table; charts are `line-chart.tsx` or a library analytics component.

## 2. Buttons

- One primary button per view (the main action of the page header or the form's submit). Everything else is
  `secondary`, `ghost` or `link`.
- Destructive actions use the `destructive` variant and always open `confirm-dialog.tsx`. The confirm names the
  object ("Delete app todo") and, for data loss, asks the user to type the name.
- Icon-only buttons need `aria-label` and a tooltip. Row actions that are rare go behind a `MoreHorizontal`
  dropdown; row actions used every day (Open, Roll back) stay visible.
- Sizes: `sm` in table rows and card headers, default in forms and page headers. Never `lg` inside the shell.
- Labels are verbs: "Roll back", "Switch traffic", "Export logs". Not "OK", "Submit", "Go", "Raw".
- Do: show a spinner inside the pressed button and disable it while the request runs.
- Don't: stack three full-width buttons; don't place a destructive button next to the primary one without a gap.

## 3. Selectors

- Single choice from a short list (2–6): `tabs.tsx` for views, a segmented control (`button-group`) for ranges such
  as 1 h / 24 h / 7 d.
- Single choice from a longer list: `select.tsx`. Over roughly 12 options, or when the user types to find an item
  (apps, projects, hosts): `forms/combobox`.
- Several choices: checkboxes in a list or a `combobox` with chips. Never a comma-separated text input (rule 7).
- Every selector shows its current value in the closed state and has a label; a range or period selector is placed at
  the top-right of the card it controls and applies to the whole card.
- Don't: use native `<select>` outside the sign-in and setup pages; don't mix tabs and a select to switch the same
  thing.

## 4. Icons

- Icons come from `lucide-react` at 16 px (`size-4`) in rows and 20 px in page headers, with `aria-hidden` and a
  text label next to them or an `aria-label` on the control.
- Entity tiles use `icon-tile.tsx` with the `ENTITY_HUE` entry for that entity. Apps, projects, orgs, members and
  branches get a real glyph (`Boxes`, `FolderOpen`, `Building2`, `Users`, `GitBranch`), coloured by `hueFor(name)` so
  the tint still identifies the object.
- Don't: render the first letter of a name as an icon (`LetterTile` is deprecated and must not be used in new code).
  A letter is not an icon: it carries no meaning, breaks in non-Latin scripts and looks like a placeholder avatar.
- Don't: use emoji, Unicode symbols (`→`, `•`) or coloured dots as the only status signal; pair them with a badge.

## 5. Lists and tables

Every list on a page is a bounded, scannable block. A page may not grow without limit because the data did.

- Default page size is 20 rows for tables and 10 items for lists in cards. Lists on an overview or dashboard show
  5 and link to the full page ("View all").
- Beyond the page size, a table paginates (cursor-based; "Load more" when the API has no total, numbered pages when it
  has) or scrolls inside a fixed-height container (max 480 px, header stays sticky). Pick one per list; a list never
  pushes the page footer away.
- Every list card can be collapsed from its header (`collapsible.tsx`); the collapsed state is remembered per user in
  `localStorage` under `ui.collapse.<pageId>.<cardId>`.
- Every table has: a header row, a count ("12 apps", "3 of 48"), consistent column alignment (numbers right, dates
  right, badges left), a tabular-nums font for numbers, and row actions in the last column.
- Filters live above the table in one row: a text filter, then selects, then the period. Changing a filter resets to
  page 1 and is reflected in the URL search params so the view can be shared.
- Rows are 36–40 px high; cells truncate with a title tooltip instead of wrapping, except the primary name column.
- Mobile (< 768 px): tables with more than three columns become stacked cards with the same fields in the same order.
- Don't: render a list with no limit (sessions, audit, events, node events); don't put two scrolling containers in one
  card; don't show a raw ID as the first column.

## 6. Empty, loading, error and no-data states

- Loading: `skeleton.tsx` shapes that match the final layout (rows for tables, tiles for stats), never a spinner in a
  blank page and never layout shift. Slow second loads (over 400 ms) show a thin progress bar in the top bar.
- Empty (the object has nothing yet): `empty-state.tsx` with an entity icon, a one-line title, one line of help and the
  primary action ("Add schedule"). It sits inside the card where the list would be.
- No data in a range (the object exists, the window is empty): a short sentence in the chart or table area, in muted
  text, that names the range: "No requests in the last hour." A chart keeps its axes.
- Not recorded by the runtime (the data cannot exist): do not render the card at all. If the card must stay for
  layout, say what is true in plain words ("The runtime keeps percentiles, not every request").
- Error: an inline alert with the error code from `errors.json`, a "Retry" button, and the raw message in a
  collapsed "Details". Never a toast as the only signal for a failed page load.
- Permission: a muted one-line notice ("Only project admins can change this") and disabled controls, not a hidden
  section.
- Show "No data" (via `ui/no-data.tsx`) when a panel has nothing to show, and "N/A" (via `lib/format`) for a single absent value. A measured zero is a value: render 0. Don't: print "–", "null", "unknown", an empty cell, or a blank panel. Prefer a precise state where one exists: "Never", "Not set",
  "None yet", "0", "Not recorded".

## 7. Forms

- Inputs use `input.tsx` with `label.tsx`; help text under the field, errors under the help text in the danger
  colour, with `aria-describedby`.
- Lists of values (hosts, paths, prefixes, tables, CIDR ranges, methods) use `chip-input.tsx` or a `combobox` with
  chips: one chip per value, Enter adds, Backspace removes, paste splits on whitespace and commas. A comma-separated
  text input is not allowed.
- Secrets use `type="password"` with a reveal toggle while typing, and are write-only after saving (`secret-once.tsx`
  shows a value exactly once).
- Save is per card. A card with unsaved changes shows "Unsaved changes" next to its Save button and blocks navigation
  with a confirm. Saved shows a toast and the new "In effect" value.
- Numbers show their unit in the field (ms, s, MiB, req/s) and their effective value when empty ("Empty uses the
  default: 1024").
- Settings pages use a left tab rail on desktop (General, Access, Limits, Advanced, Danger zone) and tabs on mobile;
  each tab is one scroll of cards.
- Don't: mix a form into a list card (the Members page invites form, the Alerts page channel form); open a dialog or
  a sheet from an "Add" button instead.

## 8. Charts

- Use `line-chart.tsx` for series, `stat-tile.tsx` for a number with a sparkline, and the library analytics
  components for breakdowns. Colours come from the chart tokens in `design-tokens.md`; the same metric keeps the same
  colour on every page (requests blue, errors red, p95 purple, queue teal).
- Every chart has a title, a period selector, axis labels with units, a tooltip with the exact value and timestamp,
  and a "Show as a table" toggle that renders the same points in a table (this is the accessible form).
- Series with fewer than two points render the empty-range sentence (rule 6), not a flat line.
- A sparkline inside a stat tile has no axes and no tooltip; the tile's number is the value.
- Don't: show gauges, donuts for two values, 3-D or gradient fills; don't draw a chart for data that is a single
  number.

## 9. History and timeline views

A history is anything that lists what happened over time: versions, deploys, switches and rollbacks, events, audit,
alerts, backups.

- One timeline component for all of them (`workspace/activity-feed-*` adapted into `web/src/components/ui/`): an
  icon per kind, a plain-language title, the actor, a relative time with the absolute time on hover, and an optional
  expandable detail. The detail is structured (key–value rows, steps with durations), never a JSON blob labelled "Raw".
- Deploy and version history is a table with: version, state badge, source (git SHA with link, upload, console),
  author, created, duration, and visible actions (Promote, Roll back, Build log, Diff). The live version is marked in
  its row; it is never listed in a separate card.
- Switches and rollbacks are rows in the same version history ("Rolled back v3 to v2 · 14 h ago"), not a separate
  "Switch history" card with its own statistics. Success rate and median duration belong to Analytics if anywhere.
- Every history is bounded (rule 5), filterable by kind and period, and exportable (rule 10).
- Don't: put the same events on three pages (app Overview, Node, Branches) with different wording; don't name a card
  after the mechanism ("Switch history", "Node events") instead of the user's question ("Deployments", "Activity").

## 10. Exports

Anything a user may need outside the console can leave it in a file, with the filters that were on screen.

| Data | Formats | Where |
|---|---|---|
| App logs | `.ndjson` (one log object per line), `.txt` (as displayed) | Logs page toolbar, "Export", for the visible range and filter |
| Build log | `.txt` | Build log dialog |
| Events and activity | `.ndjson`, `.csv` | Timeline toolbar |
| Audit log | `.csv`, `.ndjson` | Audit page toolbar, honours the filters |
| Versions | `.csv` | Versions page |
| Stats and chart series | `.csv` (the same rows as "Show as a table") | Chart menu |
| Env variables | `.env` | Env page (exists) |
| App data | SQLite file (exists); a query result as `.csv` | Data page |
| Usage and quota | `.csv` | Usage page |
| Members, tokens | `.csv` | Their pages |

- The file name is `<org>-<app>-<kind>-<from>-<to>.<ext>` in UTC. The export uses the same server route as the view
  with `?format=` and a `Content-Disposition` header; the console never builds a file from a partial client cache.
- Exports over 10 000 rows stream and show a progress toast. Exports are audited (`*.export`).
- Secrets and signing keys are never exportable.

## 11. Copy

- Sentence case everywhere ("Roll back", "Env & secrets"). Product nouns: app, project, org, branch, version,
  schedule, token (see `AGENTS.md`: write "app", not "service").
- A card title is the user's noun ("Deployments", "Schedules"). The one-line description under it says what the user
  can do here, not how the runtime works. Runtime mechanics go in a tooltip or the docs link.
- Times: relative in lists ("14 h ago"), absolute with time zone on hover and in exports. Never two formats on one
  page.
- Numbers: thousands separators, at most one decimal in tiles, units attached ("36 ms", "14.6 MiB").
- Breadcrumbs name the object type when the name is ambiguous: "Default (org) › default (project) › todo" renders as
  org icon + Default › project icon + default › app icon + todo.
- Don't: shout internal names ("usr_01M6PJ…" as a visible column, "sys-sdk-rtctl", "Raw").

## 12. Density and layout

- Content column max width 1200 px, 24 px gutters, 16 px between cards, 16 px card padding (20 px on desktop for
  page-level cards).
- Page header: entity tile, title, one-line description, actions right-aligned. Status badges sit on the title line.
- Dashboards use a 12-column grid; a card is 12, 8, 6 or 4 columns. Cards in a row share a height.
- Base text 14 px, secondary 13 px, captions 12 px, code 13 px `IBM Plex Mono`. Row height 36 px in tables, 32 px in
  the sidebar.
- Don't: nest a card in a card; don't give a two-row list a 300 px card; don't centre a form on a page that has a
  sidebar.

## 13. Responsive

- Breakpoints: `sm` 640, `md` 768, `lg` 1024, `xl` 1280. The shell sidebar collapses under `md` into a sheet; the app
  navigation becomes a horizontally scrollable tab strip with the active tab scrolled into view.
- Under `md`: stats grid 2 columns, charts full width, tables become cards (rule 5), page actions move under the
  title, period selectors stay on one line and scroll.
- Tap targets at least 40 px; no hover-only actions (row actions always visible under `md`).
- Test at 375 px and 1440 px before opening a pull request; `scripts/screenshots` output goes in the PR.

## 14. Theme

- Only token classes (`bg-surface`, `text-muted`, `border-line`, status tokens). No raw hex, no `dark:` overrides in
  components: the tokens already switch.
- Both themes must pass the AA check in `web/src/styles/contrast.test.ts`; a new colour pair is added there first.
- Status colours mean one thing everywhere: green ready/ok, blue live/info, amber pending/building, red failed/danger,
  grey stopped/disabled.
- Charts, code blocks and the log view keep their own background token (`bg-canvas-inset`) so they read the same in
  both themes.

## 15. Checklist for a UI pull request

1. Uses `ui/` primitives or a library component; no new one-off control.
2. Every list is bounded, collapsible and (where it is a history or a log) exportable.
3. No blank panels, letter tiles, comma-separated inputs or "Raw" buttons; absent data says "No data" or "N/A".
4. Loading, empty, error and permission states exist and match rule 6.
5. Works at 375 px and 1440 px, in light and dark; screenshots attached.
6. Copy follows rule 11; strings are in `web/src/locales/en/*.json` with `ru` and `uz` entries.
7. Tests cover the states in 4 and the interactions of the new control.
