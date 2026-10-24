---
name: ui-design
description: Use when changing the Runtime Web console UI (web/): styling with the design tokens, buttons, badges and status chips, accessibility, or adding a page or feature with TanStack Query hooks and MSW-backed tests.
---

# UI design in the Runtime Web console

The console is calm, Notion-like and utilitarian. Start from the tokens and the existing primitives. Do not invent a
new look per page.

Source of truth: `web/src/index.css` (tokens on `:root` and `.dark`, mapped to Tailwind with `@theme inline`) and
`docs/contributing/design-tokens.md` (the human-readable table).

## Stack

- Vite, React 19, TypeScript strict, Tailwind v4 (`@tailwindcss/vite`).
- TanStack Router (file routes in `web/src/routes/`) and TanStack Query (hooks in `web/src/hooks/` and
  `web/src/components/features/<feature>/hooks.ts`).
- Primitives in `web/src/components/ui/` built on `cva` and `cn()` (`web/src/lib/utils.ts`). Icons from `lucide-react`.
- Toasts from `sonner`. Tests: Vitest, Testing Library, MSW.

## Tokens

Use token classes, never raw hex values in components.

| Need | Use |
|---|---|
| Page background | `bg-bg` |
| Sidebar and chrome | `bg-panel` |
| Recessed fill, table headers | `bg-panel-2` |
| Cards, inputs, dialogs | `bg-surface` |
| Hairlines | `border-line`; control borders `border-line-strong` |
| Hover and ghost wash | `hover:bg-hover`, `active:bg-active` |
| Primary and secondary text | `text-text`, `text-muted` (muted passes AA on every surface) |
| Brass accent: primary button, links, focus | `bg-accent`, `hover:bg-accent-hover`, `text-on-primary` |
| Selection, selected nav item | `bg-accent-soft`, `bg-accent-pale` |
| Focus ring | `ring-focus` (the primitives already set it) |
| Destructive and errors | `text-danger-text`, `bg-danger-soft`, `bg-danger` |

Shape and motion:

- Radius: `rounded-sm` (4px) for controls, badges and skeletons; `rounded-md` (6px) for cards, menus and dialogs. Do not
  go above 6px. `rounded-full` is used only for small status chips and the progress bar.
- Depth: `shadow-menu` for popovers, dialogs and toasts. No gradients, no glass effects.
- Motion: default transition is 140ms with `ease-ui`. Reduced motion already disables transitions globally.
- Type: 14px base, IBM Plex Sans and Mono. Use `tabular-nums` for numeric columns. Headings follow the table in the
  design tokens doc.
- Control heights: buttons `h-7` (default) and `h-6` (sm), inputs `h-7`. Icons are `size-4`.

## Buttons

Use `Button` from `web/src/components/ui/button.tsx`. Its `variant` and `size` props come from `cva`:

- `variant`: `default` (accent fill, for the one primary action per view), `secondary` (the default when omitted:
  surface with a border), `ghost` (no border, hover wash) and `danger` (soft red, for destructive actions).
- `size`: `default` (`h-7`), `sm` (`h-6`), `icon` (`size-7`) and `icon-sm` (`size-6`).
- Pass `asChild` to render a link with button styles.

Do not hand-roll button classes. There are no pill-shaped buttons in this design; a button is a 4px-radius control.
When a request says "pill buttons", check with the user: the current design uses 4px-radius controls.

## Badges and status

Use `Badge` (`web/src/components/ui/badge.tsx`) with its variants: `default`, `success`, `danger`, `warning`, `info`
and `outline`. They map to the tinted tag tokens `tag-{gray,brown,orange,yellow,green,blue,purple,pink,red}-{bg,text}`,
and each pair is contrast-checked. Use a tag token directly only when `Badge` cannot express the case.

Status chips that show lifecycle state live next to their feature, for example
`web/src/components/features/app-settings/status-pill.tsx`. Reuse one of those before adding another.

There is no `IconTile` component in the codebase. If you need a tinted icon square, build it from a tag token pair and a
`lucide-react` icon, and keep it to one place.

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

Run `make web-test` and `make web-lint` before you finish. `make ci` runs both.
