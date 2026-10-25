---
name: ui-design
description: Use when changing the Runtime Web console UI (web/): styling with the neutral design tokens, buttons, cards, SectionCard, PageHeader, IconTile and ENTITY_HUE colours, badges, the app sidebar and val.town-style app pages, accessibility, or adding a page or feature with TanStack Query hooks and MSW-backed tests.
---

# UI design in the Runtime Web console

The console is calm and neutral: a white canvas, a soft off-white sidebar, hairline dividers, one blue
accent and small colourful entity tiles. The shell is Dokploy-like (grouped sidebar, breadcrumb top bar),
the App pages follow val.town (the sidebar becomes the app's navigation; a live URL bar with preview;
Code with file list, editor, preview pane and logs dock). Dark mode is three neutral greys (#191919,
#202020, #262626) with white washes. No gradients, glass, neon, warm/brown or blue-black darks.

Source of truth: `web/src/index.css` (tokens on `:root` and `.dark`, mapped to Tailwind with
`@theme inline`) and `docs/contributing/design-tokens.md` (the spec with hexes, type scale and
page wireframes). Start from the tokens and the existing primitives. Do not invent a new look per page.

## Stack

- Vite, React 19, TypeScript strict, Tailwind v4 (`@tailwindcss/vite`).
- TanStack Router (file routes in `web/src/routes/`) and TanStack Query (hooks in `web/src/hooks/` and
  `web/src/components/features/<feature>/hooks.ts`).
- Primitives in `web/src/components/ui/` built on `cva` and `cn()` (`web/src/lib/utils.ts`). Icons from
  `lucide-react`. Toasts from `sonner`. Tests: Vitest, Testing Library, MSW.
- `RTWEB_DEV_PROXY=http://host:port npm run dev` proxies `/api` to a running backend for visual checks.

## Tokens

Use token classes, never raw hex values in components. Every text/fill pair is AA-checked in
`web/src/styles/contrast.test.ts` (both themes); add a case there when you add a pair.

| Need | Use |
|---|---|
| Page background | `bg-bg` (#FFFFFF / #191919) |
| Sidebar, auth canvas, table headers, logs | `bg-panel` |
| Recessed fill (kbd, code chips, segmented track) | `bg-panel-2` |
| Cards | `bg-surface`; raised cards, menus, dialogs, active controls `bg-surface-2` |
| Input and select fill | `bg-field` |
| Hairlines | `border-line`; control borders and hover `border-line-strong` |
| Hover and active wash | `hover:bg-hover`, `bg-active` |
| Primary and secondary text | `text-text`, `text-muted` |
| Accent: primary button, links, focus | `bg-accent`, `hover:bg-accent-hover`, `text-on-primary`, `text-accent` |
| Selection, info badge | `bg-accent-soft`, `bg-accent-pale` |
| Focus ring | `ring-focus` (the primitives already set it) |
| Destructive | `text-danger-text`, `bg-danger-soft`; solid `bg-danger text-on-danger` |
| Soft tints (badges, tiles, avatars) | `tag-{gray,brown,orange,yellow,green,blue,purple,pink,red,teal}-{bg,text}` |
| Solid tiles and status dots | `bg-tag-{hue}-solid` |

Shape and motion:

- Radius: `rounded-md` (6px) for buttons, inputs, badges, sidebar rows and menu items; `rounded-lg` (10px)
  for cards, tables, dialogs and menus; `rounded-xl` for large icon tiles.
- Depth: `shadow-card` (1px faint) on cards and bordered controls; `shadow-menu` on menus, popovers,
  dialogs and toasts.
- Motion: default 140ms `ease-ui`; dialogs and menus `pop-in`, overlays `fade-in`, the mobile sheet
  `slide-in-left`. Reduced motion disables transitions globally.
- Type: 14px base, Inter (self-hosted, `cv11 ss01`) and IBM Plex Mono. `tabular-nums` for numbers.
  Page title `text-xl font-semibold tracking-[-0.01em]` through `PageHeader`; section title
  `text-[15px] font-semibold`; settings group label `SectionLabel` (11px uppercase).
- Controls: buttons `h-8` (default), `h-7` (sm), `h-9` (lg); inputs and selects `h-9`. Icons `size-4`,
  stroke 1.75 (tiles use 2).

## Buttons

Use `Button` from `web/src/components/ui/button.tsx` (`variant`, `size` from `cva`):

- `variant`: `default` (accent fill, one primary action per view), `secondary` (bordered white fill,
  the default when omitted), `ghost` (hover wash, toolbars and row actions), `danger` (soft red, row-level
  destructive), `danger-solid` (red fill inside confirm dialogs; `ConfirmDialog` uses it), `link`.
- `size`: `default`, `sm`, `lg`, `icon`, `icon-sm`. Pass `asChild` to render a link with button styles.

Do not hand-roll button classes. Small controls inside a `SectionCard` header (filters, "View all", ⋮)
use `SMALL_CONTROL` / `SMALL_ICON` from `ui/section-card.tsx`.

## Cards and page building blocks

- `PageHeader` (`ui/page-header.tsx`): entity tile + h1 + description + actions. Every page starts with it
  (except the App overview, which has its own identity block).
- `Card` (`ui/card.tsx`): plain container. `SectionCard` (`ui/section-card.tsx`): titled panel with
  description, small controls and `flush` for edge-to-edge lists and tables (`<Table bare>`).
- `StatTile`, `SectionLabel`, `Kbd` in `ui/page-header.tsx`. `UrlBar` and `CopyButton` in `ui/url-bar.tsx`.
- `EmptyState` (`ui/empty-state.tsx`) with `entity=…` and one CTA; `bare` inside a card.
- Formatting helpers in `web/src/lib/format.ts`: `formatBytes`, `formatCount`, `formatDuration`,
  `formatRelative`, `formatQuantity(key, value)` (unit from the key name), `labelFor`. Never show raw
  bytes, milliseconds or JSON to the user; `KeyValueCard` and `eventFields` show how to flatten objects.

## Icon tiles and entity colours

`IconTile` is a rounded square in a tag tint with a `lucide-react` icon: `<IconTile icon={Boxes}
entity="apps" size="xs|sm|md|lg|xl" solid? />`. `solid` is the saturated white-glyph tile (projects in the
sidebar, quick actions, templates). `LetterTile` is the same square with an initial (apps, orgs, people;
`hueFor(name)` picks a stable hue). `ENTITY_HUE` gives every entity one colour: overview orange, apps and
code blue, projects yellow, logs teal, triggers pink, versions purple, env/domains green,
tokens/secrets brown, members/invites purple, admin red, audit/settings gray, security teal.

## Shell, sidebar and app pages

- `AppShell` (`layout/app-shell.tsx`) owns palette, theme and collapse state and wraps page content in
  `PageBody` (max 1100px) unless the route sets `staticData: { fullBleed: true }` (Code, Logs, the app
  layout). Instance-admin pages (`routes/admin.tsx`) use the same shell and sidebar; the shell keeps
  the last opened org.
- `Sidebar` (`layout/sidebar.tsx`) shows the org navigation (Overview, Members, Tokens, Audit log,
  Settings, then Projects with nested apps, then the Instance group from `INSTANCE_SECTIONS` for
  instance admins only) or, on `/$org/apps/$app/*`, the app navigation from
  `APP_SECTIONS` (Overview, Code, Logs, Triggers, Versions, Env & Secrets, Domains, Settings) under the app
  identity. Below `md` the app sections render as the `AppTabs` strip (`aria-label="App sections"`).
- Add an app page by adding a route file, a `PageBody`-wrapped component and an entry in `APP_SECTIONS`.
- Breadcrumbs: org / project / app / section (`layout/breadcrumbs.tsx`).

## Badges and status

`Badge` (`ui/badge.tsx`) is a 20px chip: `default`, `success`, `danger`, `warning`, `info`, `accent`,
`blue`, `purple`, `teal`, `outline`; `dot` adds a status dot. Build states map ready → success, failed →
danger, building/pending → warning. `features/app-settings/status-pill.tsx` is the app status line.

## Accessibility

- Every interactive element is a real `button`, `a` or form control. Clickable `div`s are a bug.
- Icon-only buttons need `aria-label` (and a `title` when the action is not obvious).
- Keep the focus ring visible (`focus-visible:ring-2 ring-focus`). Never remove outlines without one.
- Inputs have a `Label`; errors use `aria-invalid` and `aria-describedby`.
- Dialogs use `ui/dialog.tsx`; destructive actions use `ui/confirm-dialog.tsx` (focus lands on Cancel,
  optional typed confirmation, specific confirm label).
- Colour is never the only signal; pair dots and tints with text. Tables use real `table` markup.
- Hover-revealed row actions must also show on focus and on touch (`group-focus-within`,
  `[@media(hover:none)]:opacity-100`).

## Data: Query hooks, never fetch in components

Components read and write through hooks in `hooks.ts` next to the feature (see `features/env/env-editor.tsx`
for `useEnv` / `useSaveEnv`). Query keys start with the resource name and include every input; mutations
invalidate the keys they affect in `onSuccess`; `If-Match` goes through `api.patch(..., { ifMatch })` and
a 409 `stale` gets its own dialog (`features/editor/code-page.tsx`). Set `meta: { skipGlobalError: true }`
only when the page shows its own error.

## Adding a page or feature

1. Route file in `web/src/routes/` (the Vite plugin regenerates `routeTree.gen.ts`); the route only loads
   data and renders the feature component inside `PageBody` when its parent is full-bleed.
2. Feature folder `web/src/components/features/<feature>/` with `<feature>-page.tsx`, `hooks.ts`.
3. Role gating through `useCan` (`web/src/hooks/authz.ts`); hide controls the caller cannot use.
4. States: loading (`Skeleton`), empty (`EmptyState` with one CTA), error (`empty/query-error.tsx`).
5. Tests next to the feature: MSW handlers per case (`server.use`), `renderAt(path)` from
   `web/src/test/render.tsx`, assert what the user sees (role-gated controls, error path, success path).
6. Check both themes at 1440 and 375 in a browser before finishing. Run `cd web && npm run lint && npm test
   && npm run build && npm run coverage`; `scripts/budget.sh` keeps the first route under 250 KB gzip.
