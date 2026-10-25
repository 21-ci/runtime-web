import type { CSSProperties } from "react";

import { deriveAccent, isHex, type AccentPalette } from "./color";
import { DEFAULT_PRODUCT_NAME, type BrandingWrite, type Radius, type Tint } from "./hooks";

// Token values for the live preview. They mirror the server's theme.css (server/src/branding/
// service.ts) so the preview shows what Save will apply; keep the numbers in sync.

const RADII: Record<Exclude<Radius, "default">, Record<string, string>> = {
  sharp: { "--r-sm": "2px", "--r-md": "3px", "--r-lg": "4px", "--r-xl": "6px", "--r-2xl": "8px" },
  round: { "--r-sm": "6px", "--r-md": "9px", "--r-lg": "14px", "--r-xl": "16px", "--r-2xl": "22px" },
};

const TINTS: Record<Exclude<Tint, "neutral">, { light: Record<string, string>; dark: Record<string, string> }> = {
  warm: {
    light: { "--panel": "#f8f6f1", "--panel-2": "#efebe3", "--secondary": "#f3f0e9", "--secondary-hover": "#eae5dc" },
    dark: { "--panel": "#211f1c", "--panel-2": "#2c2925", "--surface": "#211f1c", "--surface-2": "#282521", "--secondary": "#2e2b27", "--secondary-hover": "#36322d" },
  },
  cool: {
    light: { "--panel": "#f5f7fa", "--panel-2": "#eceff4", "--secondary": "#eff2f6", "--secondary-hover": "#e5e9ef" },
    dark: { "--panel": "#1e2024", "--panel-2": "#282b30", "--surface": "#1e2024", "--surface-2": "#24272c", "--secondary": "#2b2e33", "--secondary-hover": "#33363c" },
  },
};

const paletteVars = (p: AccentPalette) => ({
  "--accent": p.accent,
  "--accent-hover": p.hover,
  "--on-primary": p.onAccent,
  "--accent-soft": p.soft,
  "--accent-pale": p.pale,
});

const DEFAULT_RADII = { "--r-sm": "4px", "--r-md": "6px", "--r-lg": "10px", "--r-xl": "12px", "--r-2xl": "16px" };

/** CSS variables for one preview panel. */
export function previewVars(draft: Pick<BrandingWrite, "accent" | "radius" | "tint">, theme: "light" | "dark"): CSSProperties {
  const vars: Record<string, string> = { ...(draft.radius === "default" ? DEFAULT_RADII : RADII[draft.radius]) };
  if (isHex(draft.accent)) Object.assign(vars, paletteVars(deriveAccent(draft.accent)[theme]));
  if (draft.tint !== "neutral") Object.assign(vars, TINTS[draft.tint][theme]);
  return vars as CSSProperties;
}

export type PreviewAssets = { logoLight: string | null; logoDark: string | null; icon: string | null };

/** A miniature sign-in card plus a few console controls, in one theme. */
export function BrandPreview({
  draft,
  assets,
  theme,
}: {
  draft: BrandingWrite;
  assets: PreviewAssets;
  theme: "light" | "dark";
}) {
  const name = draft.product_name || DEFAULT_PRODUCT_NAME;
  const logo = theme === "dark" ? (assets.logoDark ?? assets.logoLight) : assets.logoLight;
  const branded = Boolean(draft.product_name || assets.logoLight || assets.icon);
  return (
    <figure
      aria-label={`${theme === "dark" ? "Dark" : "Light"} preview`}
      className={`${theme} flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-panel text-text`}
      style={previewVars(draft, theme)}
    >
      <figcaption className="border-b border-line px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
        {theme === "dark" ? "Dark" : "Light"}
      </figcaption>
      <div className="flex flex-col items-center gap-2 px-4 pb-4 pt-5">
        {logo ? (
          <img src={logo} alt="" className="h-7 max-w-[160px] object-contain" />
        ) : assets.icon ? (
          <img src={assets.icon} alt="" className="size-8 rounded-lg object-contain" />
        ) : (
          <span className="size-8 rounded-lg bg-accent" aria-hidden="true" />
        )}
        <p className="text-sm font-semibold">{draft.login_headline || "Welcome back"}</p>
        <p className="max-w-[28ch] text-center text-[12px] text-muted">{draft.login_subtitle || `Sign in to ${name}.`}</p>
        <div className="mt-1 flex w-full flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3 shadow-card">
          <span className="h-7 rounded-md border border-line-strong bg-field" aria-hidden="true" />
          <span className="flex h-7 items-center justify-center rounded-md bg-accent text-[12px] font-medium text-on-primary">
            Sign in
          </span>
          <span className="flex items-center justify-between text-[12px]">
            <span className="text-accent underline">Forgot password?</span>
            <span className="rounded-md bg-accent-pale px-1.5 text-accent">New</span>
          </span>
        </div>
        <p className="text-[11px] text-muted">
          {name}
          {branded && !draft.hide_powered_by ? " · Powered by Runtime Web" : ""}
        </p>
      </div>
    </figure>
  );
}
