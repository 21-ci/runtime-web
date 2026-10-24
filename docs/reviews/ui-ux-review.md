# UI/UX review (Task 16)

Scope: visual identity and a UX pass across the console. The owner's request was a UI that does not look like a
generic AI dashboard.

## New look

| Role | Light | Dark |
|------|-------|------|
| Base (`--bg`) | `#eeefeb` concrete grey | `#141614` graphite |
| Surface (`--surface`) | `#f9f9f7` | `#181b19` |
| Text / muted | `#1b1e1c` / `#555b56` | `#e5e6e1` / `#9ba19a` |
| Accent (`--accent`) | `#8a560a` brass | `#e0a43a` brass |
| Success / danger | `#2c6a3a` / `#b3261e` | `#74c08a` / `#ee8679` |

- One warm metal accent on cool-neutral greys: reads as an instrument panel, not a SaaS template. No blue, purple,
  gradients or glows. Status colors are muted so they do not compete with the accent.
- Type: IBM Plex Sans (400/500/600) for UI, IBM Plex Mono (400/500) for code, IDs and keys. Self-hosted, Latin
  subset only, via `@fontsource/ibm-plex-sans@5.3.0` and `@fontsource/ibm-plex-mono@5.3.0` (pinned). Tabular figures on.
- Radii: 4px for controls, 6px for cards and dialogs (was 6 to 12px mixed). One custom shadow for floating layers.
- Active nav item gets a 2px inset accent bar plus a pale accent fill.
- Token names: `blue*` became `accent*`, `navy` became `overlay`. `.dark` is still the single dark set; `theme-init.js`
  is unchanged.

## Findings

### Must
- **Primary actions rendered as secondary buttons.** `Button` defaults to `secondary`, and 21 form submits plus the
  page-header "New ..." actions did not set a variant, so no screen had a clear primary action. Changed: every
  submit without an explicit variant and every "New ..." header action now uses `variant="default"`.
- **`/` was a placeholder title on a blank page.** Changed: it sends the user to their first organization; with
  none it shows an empty state ("No organizations yet") with a link to Admin, plus loading and error states.
- **Contrast coverage was thin.** The test checked only filled controls. Changed: it now also checks body and muted
  text on bg, surface and panel-2, accent links, the selected nav item, primary hover and danger text, in both themes.

### Should
- **Sign-in card had a fixed 360px min-height**, which left a large empty block under short forms (worst at
  375px). Changed: card sizes to content; the shell is pinned near the top so the title does not jump while config
  loads.
- **Density.** Topbar 56 to 48px, inputs and selects 38 to 34px (now match buttons), table rows `p-3` to `px-3 py-2`,
  header row 36px with a stronger rule. Main content is capped at 1280px.
- **All-caps tracked labels** (sidebar "Projects", others) removed; sentence-case small labels instead.
- **Empty states** were large and centered with an 32px icon on a tinted panel. Now a quieter dashed outline,
  20px icon, smaller title.
- **Copy:** "Saving..." style ASCII ellipses replaced with "…" to match the rest. No exclamation marks or "val" found.
- **Reduced motion** now respected globally; text selection uses the accent tint.

### Could (not done)
- Native `<select>` in admin dialogs (owner picker, schedules, HTTP method) still uses browser chrome; switch to the
  Radix `Select` for consistency.
- Long emails wrap mid-word in the admin users table at 375px; truncate with a title tooltip.
- The theme toggle uses three icon buttons in the mobile topbar; a single cycling button would free space.
- Command menu button is hidden below `sm`; consider an icon-only trigger on mobile.

## Verification

Built `web/dist`, ran `bin/rtweb` locally in dev mode with an unreachable runtime, created a test admin via
`/setup`, and inspected in the built-in browser:
- 1280px light and dark: setup, sign-in, home empty state, admin users and organizations, org overview shell.
- 375px light and dark: sign-in, admin users, org overview with the mobile nav.

App pages that need the runtime (code, logs, triggers, versions, settings) could not show data in this setup;
they were reviewed in code only. Their shared parts (tables, inputs, buttons, dialogs, empty states) are the ones
changed above.

Checks: `npm run lint` clean, `npx vitest run` 27 files / 145 tests pass, `npm run build` ok,
`scripts/budget.sh` first-route JS 119 KB gz (limit 250), editor 171 KB gz, TS worker 1.36 MB gz.

## Before / after

- Before: white panels, sky-blue primary (`#0369a1`), indigo-navy dark theme, Inter fallback (not shipped, so system
  font), 8 to 12px radii, every button grey.
- After: concrete/graphite neutrals, brass primary used only for the main action and selection, IBM Plex
  Sans/Mono shipped with the app, 4/6px radii, denser tables and controls.
