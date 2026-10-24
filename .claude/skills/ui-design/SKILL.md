---
name: ui-design
description: Use when changing the Runtime Web console UI (web/): styling with the warm design tokens, pill buttons, cards, IconTile and ENTITY_HUE colours, badges and status chips, accessibility, or adding a page or feature with TanStack Query hooks and MSW-backed tests.
---

# UI design in the Runtime Web console

The console is warm, friendly and smooth: a warm off-white canvas, soft warm greys, rounded cards, pill buttons and
colourful icon tiles. No gradients, glass, neon or blue-black darks. Start from the tokens and the existing
primitives. Do not invent a new look per page.

Source of truth: `web/src/index.css` (tokens on `:root` and `.dark`, mapped to Tailwind with `@theme inline`) and
`docs/contributing/design-tokens.md` (the human-readable table).

## Stack

- Vite, React 19, TypeScript strict, Tailwind v4 (`@tailwindcss/vite`).
- TanStack Router (file routes in `web/src/routes/`) and TanStack Query (hooks in `web/src/hooks/` and
  `web/src/components/features/<feature>/hooks.ts`).
- Primitives in `web/src/components/ui/` built on `cva` and `cn()` (`web/src/lib/utils.ts`). Icons from `lucide-react`.
- Toasts from `sonner`. Tests: Vitest, Testing Library, MSW.

## Tokens

Use token classes, never raw hex values in components. Every text/fill pair is AA-checked in
`web/src/styles/contrast.test.ts` (both themes); add a case there when you add a pair.

| Need | Use |
|---|---|
| Page background | `bg-bg` (warm off-white #FDFCFA / dark #1F1E1C) |
| Sidebar, auth canvas, table headers | `bg-panel` |
| Recessed fill | `bg-panel-2` |
| Cards, dialogs, menus, active sidebar pill | `bg-surface` |
| Input and select fill | `bg-field` |
| Secondary button, tab track | `bg-secondary`, `hover:bg-secondary-hover` |
| Hairlines | `border-line`; control hover `border-line-strong` |
| Hover and ghost wash | `hover:bg-hover`, `active:bg-active` |
| Primary and secondary text | `text-text`, `text-muted` |
| Tomato coral accent: primary button, links, focus | `bg-accent`, `hover:bg-accent-hover`, `text-on-primary` |
| Selection, info badge | `bg-accent-soft`, `bg-accent-pale` |
| Focus ring | `ring-focus` (the primitives already set it) |
| Destructive and errors | `text-danger-text`, `bg-danger-soft`, `bg-danger` |
| Soft tints (badges, icon tiles, org avatars) | `tag-{gray,brown,orange,yellow,green,blue,purple,pink,red,teal}-{bg,text}` |

Shape and motion:

- Radius: `rounded-full` for buttons, badges, tabs and the tab track; `rounded-lg` (10px) for inputs, selects, menu
  items and sidebar rows; `rounded-xl` (14px) for menus, popovers and `SectionCard`; `rounded-2xl` (16px) for cards,
  dialogs, tables, toasts and empty states; `rounded-sm` (6px) only for dense badges and kbd.
- Depth: `shadow-card` (faint warm) for cards and the active sidebar pill; `shadow-menu` for popovers, dialogs and
  toasts.
- Motion: default transition 160ms with `ease-ui` (`--motion-ease`); dialogs `pop-in`, overlays `fade-in`. Reduced
  motion disables transitions globally.
- Type: 14px base, Inter (self-hosted, `cv11 ss01`) and IBM Plex Mono. `tabular-nums` for numeric columns. h1 is
  `text-2xl font-semibold tracking-[-0.01em]` next to an `md` IconTile; h2 `text-base font-semibold`.
- Control heights: buttons `h-8` (default) and `h-7` (sm); inputs and selects `h-9`, `rounded-lg`, `bg-field`.
  Icons are `size-4`, stroke 1.75 (tiles use 2).

## Buttons

Use `Button` from `web/src/components/ui/button.tsx`. Buttons are borderless **pills** (`rounded-full`) with a slight
press scale. Its `variant` and `size` props come from `cva`:

- `variant`: `default` (coral fill, for the one primary action per view), `secondary` (the default when omitted: soft
  grey fill), `ghost` (hover wash) and `danger` (soft red, for destructive actions).
- `size`: `default` (`h-8`), `sm` (`h-7`), `icon` (`size-8`) and `icon-sm` (`size-7`).
- Pass `asChild` to render a link with button styles.

Do not hand-roll button classes. The one exception is small secondary controls inside a `SectionCard` header
(filters, "View all", the ⋮ menu): use `SMALL_CONTROL` / `SMALL_ICON` from `ui/section-card.tsx` (lightly bordered,
`rounded-md`, not pills).

## Cards

- `Card` (`ui/card.tsx`): `rounded-2xl`, hairline, `bg-surface`, `shadow-card`, `p-5`. The default container for a
  settings block or a list.
- `SectionCard` (`ui/section-card.tsx`): `rounded-xl` dashboard card with a bold title row and small controls. The org
  overview (`features/overview/dashboard.tsx`) is built from these: quick-action cards (IconTile + title + subtitle),
  then Apps tiles, Recent activity and Members.
- `EmptyState` (`ui/empty-state.tsx`) with `entity=…` shows an `lg` IconTile.

## Icon tiles and entity colours

`IconTile` (`web/src/components/ui/icon-tile.tsx`) is a rounded square in a tag tint with a `lucide-react` icon:
`<IconTile icon={Boxes} entity="apps" size="xs|sm|md|lg" />`. `ENTITY_HUE` in the same file gives every entity type
one colour so the same thing always looks the same: overview orange, apps blue, projects yellow, logs teal, triggers
pink, keys/tokens/secrets brown, env/domains green, members/invites purple, admin red, audit/settings gray, security
teal, versions blue. Use `sm` in the sidebar's Projects section, `md` in page headers, `lg` in empty states. Add a new
entity to `ENTITY_HUE` rather than picking a hue ad hoc; pass `hue=` only for things that are not entities.

## Sidebar and shell

Org switcher with collapse, a search field that opens ⌘K, plain line icons for the main nav, then a Projects
section with small coloured tiles and nested apps. The top bar has the breadcrumb on the left and the user avatar
with a chevron on the right. Shell fixtures for tests live in `web/src/test/shell-fixtures.ts`.

## Badges and status

Use `Badge` (`web/src/components/ui/badge.tsx`), always a pill, with its variants: `default` (gray), `success`
(green), `danger` (red), `warning` (yellow), `info` (accent), `accent` (orange) and `outline`. They map to the tag
token pairs. Use a tag token directly only when `Badge` or `IconTile` cannot express the case.

Status chips that show lifecycle state live next to their feature, for example
`web/src/components/features/app-settings/status-pill.tsx`. Reuse one of those before adding another.

## Accessibility

- Every interactive element is a real `button`, `a` or form control. Clickable `div`s are a bug.
- Icon-only buttons need an accessible name (`aria-label`) and a tooltip if the action is not obvious.
- Keep the focus ring visible (`focus-visible:ring-2 ring-focus`). Do not remove outlines without a replacement.
- Inputs have a `label` (`web/src/components/ui/label.tsx`). Errors are tied to the input with `aria-describedby`.
- Dialogs use `web/src/components/ui/dialog.tsx` (focus trap and Escape handling come from it). Destructive actions use
  `confirm-dialog.tsx`.
- Colour is never the only signal: pair a tag with text.
- Tables use real `table` markup through `web/src/components/ui/table.tsx`.

## Data: Query hooks, never fetch in components

Components read and write through hooks. The API client is `web/src/lib/api.ts`; it sends `credentials: "include"` and
`X-CSRF-Token`. Shape the hook like the existing ones:

```ts
export function useMembers(org: string) {
  return useQuery({
    queryKey: ["members", org],
    queryFn: () => api.get<{ items: Member[] }>(`/orgs/${encodeURIComponent(org)}/members`).then((r) => r.items),
  });
}

export function useSetMemberRole(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ user, role }) => api.patch(`/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(user)}`, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members", org] }),
  });
}
```

Rules:

- Query keys start with the resource name and include every input (`["members", org]`).
- Mutations invalidate the keys they affect in `onSuccess`.
- Types for API shapes live next to the hook and cite the endpoint in `docs/reference/api.md`.
- Set `meta: { skipGlobalError: true }` on a mutation only when the page shows its own error.

## Adding a page or feature

1. Route: add a file in `web/src/routes/` (for example `$org.projects.$p.tsx`). The route only loads data and renders
   the feature component. Run the route generator (the Vite plugin does this on `npm run dev`) so
   `web/src/routeTree.gen.ts` is up to date.
2. Feature folder: `web/src/components/features/<feature>/` with `<feature>-page.tsx`, `hooks.ts`, and any helpers.
3. Hooks: add the queries and mutations in `hooks.ts`.
4. Role gating: check the caller's role with the existing helpers (`web/src/hooks/authz.ts`, `web/src/hooks/orgs.ts`)
   and hide controls the caller cannot use. The server still enforces the rule.
5. States: every query page needs loading (`skeleton.tsx`), empty (`empty-state.tsx` or the `empty/` components) and
   error (`empty/query-error.tsx`) states.
6. Tests, next to the feature (`<feature>.test.tsx`):
   - Mock the API with MSW. Add defaults to `web/src/test/msw.ts` only when every test needs them; otherwise override
     per case with `server.use(http.get(...))`.
   - Render with the helpers in `web/src/test/render.tsx` (`renderAt(path)`), which provide the router and the query
     client.
   - Test what the user sees: role-gated controls, the error path, and the success path that invalidates data.
   - Use `apiError(status, code)` from `msw.ts` for error responses.

Run `make web-test` and `make web-lint` before you finish, and `cd web && npm run coverage` (CI fails below the
thresholds in `web/vitest.config.ts`). `make ci` runs lint and tests.
