import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { deriveAccent, isHex } from "@shared-branding/color";
import { paletteVars, RADIUS_VARS, TINT_VARS } from "@shared-branding/tokens";
import { DEFAULT_PRODUCT_NAME, UPSTREAM_NAME, type BrandingWrite } from "./hooks";

/** CSS variables for one preview panel. */
export function previewVars(draft: Pick<BrandingWrite, "accent" | "radius" | "tint">, theme: "light" | "dark"): CSSProperties {
  const vars: Record<string, string> = { ...RADIUS_VARS[draft.radius] };
  if (isHex(draft.accent)) Object.assign(vars, paletteVars(deriveAccent(draft.accent)[theme]));
  if (draft.tint !== "neutral") Object.assign(vars, TINT_VARS[draft.tint][theme]);
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
  const { t } = useTranslation("branding");
  const name = draft.product_name || DEFAULT_PRODUCT_NAME;
  const logo = theme === "dark" ? (assets.logoDark ?? assets.logoLight) : assets.logoLight;
  const branded = Boolean(draft.product_name || assets.logoLight || assets.icon);
  return (
    <figure
      aria-label={theme === "dark" ? t("preview.darkLabel") : t("preview.lightLabel")}
      className={`${theme} flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-panel text-text`}
      style={previewVars(draft, theme)}
    >
      <figcaption className="border-b border-line px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
        {theme === "dark" ? t("preview.dark") : t("preview.light")}
      </figcaption>
      <div className="flex flex-col items-center gap-2 px-4 pb-4 pt-5">
        {logo ? (
          <img src={logo} alt="" className="h-7 max-w-[160px] object-contain" />
        ) : assets.icon ? (
          <img src={assets.icon} alt="" className="size-8 rounded-lg object-contain" />
        ) : (
          <span className="size-8 rounded-lg bg-accent" aria-hidden="true" />
        )}
        <p className="text-sm font-semibold">{draft.login_headline || t("defaults.headline")}</p>
        <p className="max-w-[28ch] text-center text-[12px] text-muted">{draft.login_subtitle || t("preview.subtitle", { name })}</p>
        <div className="mt-1 flex w-full flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3 shadow-card">
          <span className="h-7 rounded-md border border-line-strong bg-field" aria-hidden="true" />
          <span className="flex h-7 items-center justify-center rounded-md bg-accent text-[12px] font-medium text-on-primary">
            {t("preview.signIn")}
          </span>
          <span className="flex items-center justify-between text-[12px]">
            <span className="text-accent underline">{t("preview.forgot")}</span>
            <span className="rounded-md bg-accent-pale px-1.5 text-accent">{t("preview.new")}</span>
          </span>
        </div>
        <p className="text-[11px] text-muted">
          {name}
          {branded && !draft.hide_powered_by ? ` ${t("poweredBy", { name: UPSTREAM_NAME })}` : ""}
        </p>
      </div>
    </figure>
  );
}
