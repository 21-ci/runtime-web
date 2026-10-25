import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

import { isBranded, productName, UPSTREAM_NAME, useBranding, type Branding } from "./hooks";

// The first paint already carries the brand: the server renders index.html with the product
// name in <title> and the uploaded icon (else the bundled favicon.svg), and links
// /api/branding/theme.css. BrandingEffects keeps the document in step after an admin saves:
// the tab title, the favicon and a fresh theme.css (the etag busts the browser cache).
/** The bundled favicon (web/public/favicon.svg), used while no icon is uploaded. */
export const DEFAULT_ICON = "favicon.svg";

export function BrandingEffects() {
  const { data } = useBranding();
  const name = productName(data);
  const etag = data?.etag;
  const icon = data?.icon_url ?? null;

  useEffect(() => {
    document.title = name;
  }, [name]);

  useEffect(() => {
    if (!etag) return;
    const link = document.querySelector<HTMLLinkElement>("link[data-brand-theme]");
    if (!link) return;
    const url = new URL(link.href, document.baseURI);
    if (url.searchParams.get("v") === etag) return;
    url.searchParams.set("v", etag);
    link.href = url.pathname + url.search;
  }, [etag]);

  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    // Relative, so it resolves against <base href> under a path route.
    const href = icon ?? DEFAULT_ICON;
    if (link.getAttribute("href") !== href) link.setAttribute("href", href);
  }, [icon]);

  return null;
}

/** The light logo, swapped for the dark one (or the light one again) under .dark. */
export function BrandLogo({ branding, className }: { branding: Branding; className?: string }) {
  const light = branding.logo_light_url;
  if (!light) return null;
  const dark = branding.logo_dark_url ?? light;
  const alt = productName(branding);
  return (
    <>
      <img src={light} alt={alt} className={cn("block w-auto object-contain dark:hidden", className)} />
      <img src={dark} alt={alt} className={cn("hidden w-auto object-contain dark:block", className)} />
    </>
  );
}

/** Auth pages: the brand logo, else the brand icon, else `fallback`. */
export function AuthMark({ fallback }: { fallback: ReactNode }) {
  const { data } = useBranding();
  if (data?.logo_light_url) return <BrandLogo branding={data} className="h-10 max-w-[240px]" />;
  if (data?.icon_url) return <img src={data.icon_url} alt={productName(data)} className="size-12 rounded-xl object-contain" />;
  return <>{fallback}</>;
}

/** The auth page footer: the product name, plus "Powered by" unless the admin hid it. */
export function AuthFooter() {
  const { data } = useBranding();
  const { t } = useTranslation("branding");
  const branded = isBranded(data);
  return (
    <p className="mt-6 text-center text-[12px] text-muted">
      {productName(data)}
      {branded && !data?.hide_powered_by ? <span> {t("poweredBy", { name: UPSTREAM_NAME })}</span> : null}
    </p>
  );
}

/** A brand row at the top of the sidebar, only when the instance is branded. */
export function SidebarBrand() {
  const { data } = useBranding();
  if (!data || !isBranded(data)) return null;
  return (
    <div className="mb-1.5 flex h-8 min-w-0 items-center gap-2 px-1.5" data-testid="sidebar-brand">
      {data.logo_light_url ? (
        <BrandLogo branding={data} className="h-7 max-w-[190px]" />
      ) : (
        <>
          {data.icon_url ? <img src={data.icon_url} alt="" className="size-6 rounded-md object-contain" /> : null}
          <span className="truncate text-sm font-semibold">{productName(data)}</span>
        </>
      )}
    </div>
  );
}
