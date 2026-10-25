import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { DEFAULT_PRODUCT_NAME, type Radius, type Tint } from "@shared-branding/tokens";

// Instance branding (docs/reference/api.md §6.1). GET /api/branding is public, so the login
// page and the shell share one cached copy; every write returns the new view, which replaces
// the cache (the etag in it is the next If-Match).

export type AssetKind = "logo-light" | "logo-dark" | "icon";
export type { Radius, Tint };

export type PaletteView = { accent: string; hover: string; on_accent: string; soft: string; pale: string };

export type Branding = {
  product_name: string;
  accent: string;
  accent_adjusted: boolean;
  palette: { light: PaletteView; dark: PaletteView } | null;
  logo_light_url: string | null;
  logo_dark_url: string | null;
  icon_url: string | null;
  login_headline: string;
  login_subtitle: string;
  support_url: string;
  support_email: string;
  hide_powered_by: boolean;
  radius: Radius;
  tint: Tint;
  etag: string;
};

export type BrandingWrite = Pick<
  Branding,
  "product_name" | "accent" | "login_headline" | "login_subtitle" | "support_url" | "support_email" | "hide_powered_by" | "radius" | "tint"
>;

export { DEFAULT_PRODUCT_NAME };
export const UPSTREAM_NAME = "Runtime Web";
export const MAX_ASSET_BYTES = 512 * 1024;

export const BRANDING_KEY = ["branding"] as const;

/** The display name: the configured product name, else the default console name. */
export const productName = (b: Branding | undefined) => b?.product_name || DEFAULT_PRODUCT_NAME;

/** Whether the instance shows its own brand (so "Powered by" applies). */
export const isBranded = (b: Branding | undefined) => Boolean(b && (b.product_name || b.logo_light_url || b.icon_url));

export function useBranding() {
  return useQuery({
    queryKey: BRANDING_KEY,
    queryFn: () => api.get<Branding>("/branding", { skipGate: true }),
    staleTime: 5 * 60_000,
    meta: { skipGlobalError: true },
  });
}

const inline = { skipGlobalError: true };

function useSetBranding() {
  const qc = useQueryClient();
  return (data: Branding) => qc.setQueryData(BRANDING_KEY, data);
}

export function useSaveBranding() {
  const set = useSetBranding();
  return useMutation({
    meta: inline,
    mutationFn: ({ etag, body }: { etag: string; body: Partial<BrandingWrite> }) =>
      api.put<Branding>("/admin/branding", body, { ifMatch: `"${etag}"` }),
    onSuccess: set,
  });
}

export function useResetBranding() {
  const set = useSetBranding();
  return useMutation({
    meta: inline,
    mutationFn: ({ etag }: { etag: string }) => api.del<Branding>("/admin/branding", { ifMatch: `"${etag}"` }),
    onSuccess: set,
  });
}

export function useUploadBrandAsset() {
  const set = useSetBranding();
  return useMutation({
    meta: inline,
    mutationFn: ({ etag, kind, data }: { etag: string; kind: AssetKind; data: string }) =>
      api.put<Branding>(`/admin/branding/assets/${kind}`, { data }, { ifMatch: `"${etag}"` }),
    onSuccess: set,
  });
}

export function useDeleteBrandAsset() {
  const set = useSetBranding();
  return useMutation({
    meta: inline,
    mutationFn: ({ etag, kind }: { etag: string; kind: AssetKind }) =>
      api.del<Branding>(`/admin/branding/assets/${kind}`, { ifMatch: `"${etag}"` }),
    onSuccess: set,
  });
}
