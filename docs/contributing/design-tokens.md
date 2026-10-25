# Console design spec and tokens (UI v2)

The console is a calm, neutral product UI: a white canvas with a soft off-white sidebar, hairline
dividers, one restrained blue accent, and small colourful entity icons. The shell follows Dokploy's
structure (sidebar with grouped sections, breadcrumb top bar, framed content) and the App pages follow
a hosted-app model (the sidebar becomes the app's navigation, a live URL bar with preview, a code view
with file list, editor, preview pane and a logs dock). Visual rhythm is Notion's: 14px UI text, 28px
rows, 16px thin icons, hover washes instead of borders, no gradients, no glass, no neon.

Tokens live in `web/src/index.css` (`:root` light, `.dark` dark) and reach Tailwind through
`@theme inline`. Every text/fill pair is AA-checked in `web/src/styles/contrast.test.ts` for both
themes. Use token classes, never raw hex, in components.

## 1. Colour

### Surfaces, lines, text

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg` | #FFFFFF | #191919 | Page canvas |
| `panel` | #F7F7F5 | #202020 | Sidebar, auth canvas, table header, logs dock |
| `panel-2` | #EFEFEC | #2A2A2A | Recessed fills (kbd, code chips, segmented track) |
| `surface` | #FFFFFF | #202020 | Cards, dialogs, menus |
| `surface-2` | #FFFFFF | #262626 | Raised card inside a panel, active sidebar row, popovers |
| `field` | #FFFFFF | #1F1F1F | Inputs and selects |
| `secondary` / `secondary-hover` | #F1F1EF / #E8E8E5 | #2C2C2C / #343434 | Secondary button fill |
| `line` / `line-strong` | rgba(0,0,0,.08) / .16 | rgba(255,255,255,.09) / .16 | Hairlines; control hover |
| `hover` / `active` | rgba(0,0,0,.045) / .08 | rgba(255,255,255,.055) / .09 | Row and ghost washes |
| `text` / `muted` / `faint` | #1F1F1F / #6B6B6B / #8F8F8F | #E6E6E6 / #A3A3A3 / #7A7A7A | Primary, secondary, tertiary text |
| `overlay` | #000000 | #000000 | Dialog backdrop at 35% / 55% |

Dark elevation is three neutral steps: canvas #191919 → chrome and cards #202020 → raised #262626,
with `hover` white washes on top. No tinted greys, no blue-black.

### Accent and status

| Token | Light | Dark | Use |
|---|---|---|---|
| `accent` / `accent-hover` | #2563EB / #1D4ED8 | #5B9BFF / #78ADFF | Primary button fill, links, focus |
| `on-primary` | #FFFFFF | #0B1A33 | Text on `accent` |
| `accent-soft` / `accent-pale` | #DBE7FE / #EEF3FF | #1E3A6B / #1A2A45 | Selection, info badge |
| `focus` | accent 50% | accent 60% | `ring-focus` |
| `danger` / `danger-text` / `danger-soft` | #DC2626 / #B91C1C / #FEE2E2 | #F87171 / #FCA5A5 / #451A1A | Destructive controls, errors |
| `green` / `on-success` | #15803D / #FFFFFF | #4ADE80 / #052E16 | Solid success dot (rare) |

### Tag palette (badges, icon tiles, avatars)

Ten soft pairs `tag-{hue}-bg` / `tag-{hue}-text`, plus `tag-{hue}-solid` for the solid
Framer-style sidebar tiles (white glyph on a saturated square).

| Hue | Light bg / text | Dark bg / text | Solid (light / dark) |
|---|---|---|---|
| gray | #F1F1EF / #5C5C5A | #2E2E2E / #B8B8B5 | #8A8A88 / #7A7A78 |
| brown | #F3EEEA / #7B4F36 | #332A24 / #D1AE93 | #A0735A / #A77A60 |
| orange | #FCEBDD / #9A3F0C | #3B2A1C / #F2A071 | #E8702A / #E07838 |
| yellow | #FBF2D2 / #735400 | #3A3220 / #E6C565 | #E2A600 / #D9A62A |
| green | #E3F3E6 / #1F6B35 | #22312A / #7FCB92 | #2EA55A / #37B36A |
| blue | #E1EEFB / #1C5B99 | #1F2D3B / #85BBEA | #2E7BE0 / #4A90E8 |
| purple | #EEE9F8 / #603B96 | #2E2838 / #C3A5E6 | #8B5CF6 / #9A6FF5 |
| pink | #FAE8F0 / #96305F | #3A2731 / #EBA3C6 | #E04E8F / #E25E9A |
| red | #FCE6E4 / #A1302A | #402523 / #F39F99 | #E5484D / #E5555A |
| teal | #DFF3EF / #1B6558 | #203431 / #82CFC0 | #1FA38E / #2AAD98 |

## 2. Entity colours

`ENTITY_HUE` in `web/src/components/ui/icon-tile.tsx`: overview orange, projects yellow, apps blue,
code blue, logs teal, triggers pink, versions purple, env green, secrets brown, domains green,
tokens brown, members purple, invites purple, audit gray, settings gray, security teal, admin red.
`<IconTile icon entity size="xs|sm|md|lg|xl" solid? />`: soft tint by default; `solid` gives the
white-glyph tile used for project rows and quick actions.

## 3. Type

Inter (self-hosted, `cv11 ss01`), IBM Plex Mono. Base 14px / 1.5. Scale:

| Role | Class |
|---|---|
| Page title (h1) | `text-xl font-semibold tracking-[-0.01em]` (20px); the App overview name is `text-2xl` |
| Section title (h2) | `text-[15px] font-semibold` |
| Section label (settings groups) | `text-[11px] font-semibold uppercase tracking-[0.08em] text-muted` |
| UI text | 14px; dense rows and meta 13px (`text-[13px]`); captions 12px |
| Numbers | `tabular-nums` |

## 4. Spacing, shape, depth, motion

- 4px grid. Sidebar 240px; sidebar rows 28px (`h-7`) with 6px radius; top bar 48px; content column
  max 1100px with 24/40px gutters; page sections 24px apart; card padding 20px.
- Radius: `rounded-md` 6px for buttons, inputs, badges, sidebar rows and menu items; `rounded-lg` 10px
  for cards, tables and dialogs; `rounded-xl` 12px for menus/popovers and icon tiles ≥ md.
- Depth: cards are hairline + `shadow-card` (1px faint); menus, popovers, dialogs `shadow-menu`.
- Motion: 140ms `ease-ui` on colour/opacity; dialogs `pop-in` 160ms, overlays `fade-in`. Reduced
  motion disables everything.

## 5. Components

- **Button** (`ui/button.tsx`): 6px radius, `h-8` default, `h-7` sm, `h-9` lg; variants `default`
  (accent fill), `secondary` (white/`surface-2` fill with hairline, the default), `ghost`, `danger`
  (soft red fill), `danger-solid` (red fill, confirm dialogs). Icon buttons `size-8` / `size-7`.
- **Input/Select**: `h-9`, 6px radius, `bg-field`, hairline, hover `line-strong`, focus accent ring.
- **Badge**: 20px pill-less chip (`rounded-md`), 12px medium text; variants map to tag pairs; `dot`
  prop adds a status dot.
- **Card** / **SectionCard**: `rounded-lg border-line bg-surface shadow-card p-5`; `SectionCard`
  has a title row with small controls (`SMALL_CONTROL`, `SMALL_ICON`).
- **PageHeader**: IconTile md + h1 + optional description + right-aligned actions.
- **StatTile**: label 12px muted, value 20px semibold tabular.
- **UrlBar**: mono URL with method/protocol badge and Copy / Open / Reload icon buttons.
- **Tabs**: underline tabs (`TabsList` is a 36px row with a hairline, active trigger has a 2px
  text-coloured underline); segmented control stays available as `variant="segmented"`.
- **Table**: 40px rows, 12px muted uppercase-free headers on `panel`, hover wash.
- **EmptyState**: centered, large tile, one CTA.
- **ConfirmDialog**: destructive confirm with `danger-solid` button and optional typed confirmation.
- **Skeleton**: `animate-pulse bg-hover rounded-md`.

## 6. Shell

- **Org sidebar** (default): org switcher; Search (⌘K) field; nav Overview, Members, Tokens, Audit
  log, Settings; "Projects" group with solid tiles and nested apps (hover-revealed + and ⋯);
  "Instance" group (instance admins only: Users, Organizations, Audit log, Node, Cache, Domains,
  Settings); footer: Account security, collapse.
- **App sidebar** (on `/$org/apps/$app/*`): org switcher; "← Back to org" row; app identity card
  (lg tile, project, name, build dot); app nav Overview, Code, Logs, Triggers, Versions, Env &
  Secrets, Domains, Settings; same footer. Below `md` the same nav renders as a horizontal
  snap-scrolling tab strip under the top bar (`aria-label="App sections"`).
- **Top bar** 48px: menu button (mobile), expand (collapsed), breadcrumbs org / project / app,
  theme segmented control (sm+), account avatar menu.
- **Instance admin** pages render in the same shell and org sidebar (the last org the user opened
  stays in the switcher); the Instance group marks the page and the breadcrumb reads
  Instance / section. There is no separate admin console.

## 7. Page wireframes

- **Org overview**: PageHeader "Overview"; quick-action cards (New app, New project, Invite member,
  Create token, Add domain) with solid tiles; two-column grid: Apps (tiles with build dot + project /
  env) and Recent activity (timeline), then Members (avatar grid) and a right rail with Quota (units
  formatted: bytes → KiB/MiB/GiB, counts grouped) and Usage today.
- **Project**: header with tile, name, environment chips; Apps as a table-like list (tile, name,
  env, build badge, updated).
- **App overview** (hosted-app model): identity block (xl tile, project/name, Access + build + runtime
  badges, "Open" and "Edit code" buttons); UrlBar; response preview iframe; stats row (last 5
  minutes); Code card listing files with "History" → Versions; Events timeline (readable key/value
  summary per event, not raw JSON); Data export (admins).
- **Code**: toolbar (file path crumb, build status, Preview toggle, Save ⌘S); three columns: file
  list (200px), CodeMirror, preview pane (UrlBar + iframe, collapsible); problems panel; bottom
  Logs dock (collapsible, level filter, text filter, pause/clear).
- **Logs**: full-height mono stream in a `panel` frame with level chips, filter and pause/clear.
- **Triggers**: HTTP route, Schedules, Once, Queue, DLQ as SectionCards.
- **Versions**: table with build badge, live marker, author, actions (Promote / Rebuild / Log / Diff).
- **Env & Secrets**: Environment variables table (Key, Value, Added) with Add row, Edit as .env,
  Export .env, Import .env; Secrets card (names only, set / replace / delete).
- **Domains**: list with status badges, DNS records (copy) and verify/delete.
- **Settings**: left anchor nav General / Access / Limits / Advanced / Danger zone; sections with
  uppercase labels; Advanced shows slug, ID-like fields with copy and the export; Danger zone red.
- **Admin Node**: Status and Scheduler summary cards of equal height side by side (labelled
  key/value grids with units instead of raw JSON); list fields (processes, machines) as full-width
  tables below; configuration form; drain section.
- **Auth** (login, MFA, setup, change password, invite): centered 400px card on `panel` with a
  small product mark, title, subtext, form; segmented theme control is not shown there.
