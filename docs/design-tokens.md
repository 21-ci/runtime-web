# Design tokens

Defined in `web/src/index.css` (`:root` light, `.dark` dark) and exposed to Tailwind via `@theme inline`.
Style: warm, friendly, smooth. Warm off-white canvas, soft warm greys, rounded shapes, colourful icon
tiles. No gradients, glass, neon, or blue-black darks. Every text/fill pair is AA-checked in
`src/styles/contrast.test.ts` (both themes).

## Color (Tailwind: `bg-*`, `text-*`, `border-*`)

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `bg` | #FDFCFA | #1F1E1C | Page background |
| `panel` | #F9F8F6 | #252422 | Sidebar, auth canvas, table headers |
| `panel-2` | #F1EFEC | #2D2B28 | Recessed fill |
| `surface` | #FFFFFF | #242321 | Cards, dialogs, menus, active sidebar pill |
| `field` | #FBFAF8 | #2A2826 | Input and select fill |
| `secondary`, `secondary-hover` | #EFEEEC / #E6E4E1 | #353330 / #3E3B37 | Secondary button, tab track |
| `line`, `line-strong` | warm alpha | warm alpha | Hairlines; `line-strong` on control hover |
| `hover`, `active` | warm alpha | warm alpha | Ghost and row wash (`hover:bg-hover`) |
| `text`, `muted` | #2B2926 / #625D56 | #ECE9E4 / #AAA49B | Primary and secondary text |
| `accent`, `accent-hover`, `on-primary` | #C2432A / #B03C24 / #FFF | #F2845F / #F69B7C / #2A120A | Tomato coral: primary button, links, focus |
| `accent-soft`, `accent-pale` | #FBE1D7 / #FDF0EA | #4C2B1F / #35251E | Selection, info badge |
| `focus` | accent 45% | accent 55% | Focus ring (`ring-focus`) |
| `danger`, `danger-text`, `danger-soft` | | | Destructive actions and errors |
| `green`, `on-success` | | | Solid success (rare; prefer tags) |
| `overlay` | #1A1410 | #0C0A08 | Dialog backdrop (with opacity) |
| `tag-{gray,brown,orange,yellow,green,blue,purple,pink,red,teal}-{bg,text}` | | | Soft tints for badges, icon tiles, org avatars |

## Entity colours (`ENTITY_HUE` in `src/components/ui/icon-tile.tsx`)

overview orange, apps blue, projects yellow, logs teal, triggers pink, keys/tokens/secrets brown,
env/domains green, members/invites purple, admin red, audit/settings gray, security teal, versions blue.
Use `<IconTile icon={X} entity="apps" size="xs|sm|md|lg" />` in the sidebar (sm), page headers (md) and
empty states (lg, via `EmptyState entity=…`).

## Shape, depth, motion

| Token | Value |
|-------|-------|
| `rounded-sm` | 6px: badges inside dense UI, kbd |
| `rounded-md` / `rounded-lg` | 10px: inputs, selects, menu items, sidebar rows |
| `rounded-xl` | 14px: menus, select popovers |
| `rounded-2xl` | 16px: cards, dialogs, tables, toasts, empty states |
| `rounded-full` | Buttons, badges, tabs, tab track |
| `shadow-card` | Faint warm shadow for cards and the active sidebar pill |
| `shadow-menu` | Layered popover shadow (menus, dialogs, toasts) |
| `--motion-ease` | cubic-bezier(0.3, 0, 0.2, 1) |
| `--motion-fast` / `--motion-base` | 150ms / 180ms; default transition 160ms; dialogs `pop-in`, overlays `fade-in` |

Reduced motion disables transitions and animations globally.

## Type and sizing

- Base 14px, line-height 1.5. Inter (`@fontsource/inter`, self-hosted, `cv11 ss01`) for UI, IBM Plex Mono
  for code. Use `tabular-nums` for numeric columns.
- h1 `text-2xl font-semibold tracking-[-0.01em]` with an `md` IconTile; h2 `text-base font-semibold`.
- Buttons (pill, borderless): `default` 32px (`h-8`), `sm` 28px, `icon` 32px, `icon-sm` 28px.
  Variants: `default` coral, `secondary` soft grey fill, `ghost` hover wash, `danger` soft red.
- Inputs and selects 36px (`h-9`), `rounded-lg`, `bg-field`, hairline border.
- Tabs are a segmented pill control: `bg-secondary` track, active tab `bg-surface shadow-card`.
- Icons 16px (`size-4`), stroke 1.75 (global `.lucide` rule); tiles use stroke 2.

## Badge variants

`default` (gray), `success` (green), `danger` (red), `warning` (yellow), `info` (accent), `accent` (orange),
`outline`. All are pills.
