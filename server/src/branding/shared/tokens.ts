// Design-token values for the named branding options (corners, neutral tint) and the accent
// palette. One source for the server's theme.css and the console's live preview (imported
// through the web `@shared-branding` alias), so the preview shows exactly what Save applies.
// Dependency-free: it runs on the runtime (Deno) and in the Vite bundle.

import type { AccentPalette } from "./color.ts";

/** Shown wherever the admin left the product name empty. */
export const DEFAULT_PRODUCT_NAME = "Runtime Console";

export const RADII = ["sharp", "default", "round"] as const;
export const TINTS = ["neutral", "warm", "cool"] as const;
export type Radius = (typeof RADII)[number];
export type Tint = (typeof TINTS)[number];

export type Vars = Readonly<Record<string, string>>;

/** Corner radii per option; "default" matches the bundle's own :root values. */
export const RADIUS_VARS: Readonly<Record<Radius, Vars>> = {
  sharp: { "--r-sm": "2px", "--r-md": "3px", "--r-lg": "4px", "--r-xl": "6px", "--r-2xl": "8px" },
  default: { "--r-sm": "4px", "--r-md": "6px", "--r-lg": "10px", "--r-xl": "12px", "--r-2xl": "16px" },
  round: { "--r-sm": "6px", "--r-md": "9px", "--r-lg": "14px", "--r-xl": "16px", "--r-2xl": "22px" },
};

/** Panel greys per non-neutral tint, per theme. */
export const TINT_VARS: Readonly<Record<Exclude<Tint, "neutral">, { light: Vars; dark: Vars }>> = {
  warm: {
    light: { "--panel": "#f8f6f1", "--panel-2": "#efebe3", "--secondary": "#f3f0e9", "--secondary-hover": "#eae5dc" },
    dark: { "--panel": "#211f1c", "--panel-2": "#2c2925", "--surface": "#211f1c", "--surface-2": "#282521", "--secondary": "#2e2b27", "--secondary-hover": "#36322d" },
  },
  cool: {
    light: { "--panel": "#f5f7fa", "--panel-2": "#eceff4", "--secondary": "#eff2f6", "--secondary-hover": "#e5e9ef" },
    dark: { "--panel": "#1e2024", "--panel-2": "#282b30", "--surface": "#1e2024", "--surface-2": "#24272c", "--secondary": "#2b2e33", "--secondary-hover": "#33363c" },
  },
};

export const paletteVars = (p: AccentPalette): Vars => ({
  "--accent": p.accent,
  "--accent-hover": p.hover,
  "--on-primary": p.onAccent,
  "--accent-soft": p.soft,
  "--accent-pale": p.pale,
});

/** `--a:1;--b:2;` for a CSS declaration block. */
export const cssDecls = (v: Vars): string =>
  Object.entries(v)
    .map(([k, val]) => `${k}:${val};`)
    .join("");
