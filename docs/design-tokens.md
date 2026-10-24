# Design tokens

Defined in `web/src/index.css` (`:root` light, `.dark` dark) and exposed to Tailwind via `@theme inline`.
Style: calm, Notion-like, utilitarian. No gradients, glass, or radii above 6px.

## Color (Tailwind: `bg-*`, `text-*`, `border-*`)

| Token | Use |
|-------|-----|
| `bg` | Page background (light #FFFFFF, dark #191919) |
| `panel` | Sidebar and chrome (#F9F8F7 / #202020) |
| `panel-2` | Recessed fill, table headers (#F1F0EE / #2A2A2A) |
| `surface` | Cards, inputs, dialogs |
| `line`, `line-strong` | Hairlines (alpha); `line-strong` for control borders |
| `hover`, `active` | Row and ghost-control wash (alpha). Use `hover:bg-hover` |
| `text`, `muted` | Primary and secondary text; `muted` passes AA on bg, surface, panel, panel-2 |
| `accent`, `accent-hover`, `on-primary` | Brass. Primary button, links, focus only |
| `accent-soft`, `accent-pale` | Selection, selected nav item |
| `focus` | Focus ring (`ring-focus`) |
| `danger`, `danger-text`, `danger-soft` | Destructive actions and errors |
| `green`, `on-success` | Solid success (rare; prefer tags) |
| `overlay` | Dialog backdrop (use with opacity) |
| `tag-{gray,brown,orange,yellow,green,blue,purple,pink,red}-{bg,text}` | Tinted badges; each pair is AA-checked |

## Shape, depth, motion

| Token | Value |
|-------|-------|
| `rounded-sm` (`--radius-sm`) | 4px: controls, badges, skeletons |
| `rounded-md` (`--radius-md`) | 6px: cards, menus, dialogs |
| `shadow-menu` | Notion-style layered popover shadow (menus, dialogs, toasts) |
| `ease-ui` / `--motion-ease` | cubic-bezier(0.4, 0, 0.2, 1) |
| `--motion-fast` / `--motion-base` | 120ms / 160ms; default transition is 140ms |

Reduced motion disables transitions and animations globally.

## Type and sizing

- Base 14px, line-height 1.5, IBM Plex Sans / Mono. Use `tabular-nums` for numeric columns.
- h1 `text-2xl font-semibold tracking-[-0.01em]`, h2 `text-base font-semibold`, h3 `text-[13px] font-medium text-muted`.
- Labels `text-[13px] font-medium`.
- Buttons: `default` 28px (`h-7`), `sm` 24px, `icon` 28px, `icon-sm` 24px. Inputs 28px.
- Icons 16px (`size-4`), stroke 1.75 (global `.lucide` rule).

## Badge variants

`default` (gray), `success` (green), `danger` (red), `warning` (yellow), `info` (accent), `outline`.
