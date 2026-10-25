// Instance branding: display fields in settings ("branding", JSON) and images in
// branding_assets. The public view carries only what the login page and shell render.
// The etag covers both, so a stale editor gets 409 instead of overwriting a newer brand.

import { sha256Hex } from "../crypto/hash.ts";
import { invalid } from "../http/errors.ts";
import type { Db, Stmt } from "../storage/types.ts";
import { ASSET_KINDS, type AssetKind } from "./assets.ts";
import { deriveAccent, isHex, type AccentPalette } from "./shared/color.ts";
import { cssDecls, paletteVars, RADII, RADIUS_VARS, TINT_VARS, TINTS, type Radius, type Tint } from "./shared/tokens.ts";

export const SETTING_BRANDING = "branding";

export { RADII, TINTS, type Radius, type Tint };

export interface BrandingFields {
  product_name: string;
  accent: string;
  login_headline: string;
  login_subtitle: string;
  support_url: string;
  support_email: string;
  hide_powered_by: boolean;
  radius: Radius;
  tint: Tint;
}

export const DEFAULTS: BrandingFields = {
  product_name: "",
  accent: "",
  login_headline: "",
  login_subtitle: "",
  support_url: "",
  support_email: "",
  hide_powered_by: false,
  radius: "default",
  tint: "neutral",
};

const LIMITS = { product_name: 40, login_headline: 80, login_subtitle: 160, support_url: 300, support_email: 254 } as const;
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

interface AssetMeta {
  kind: AssetKind;
  mime: string;
  hash: string;
  size: number;
}

export interface Branding {
  fields: BrandingFields;
  assets: Partial<Record<AssetKind, AssetMeta>>;
  etag: string;
}

export async function getBranding(db: Db): Promise<Branding> {
  const row = await db.first<{ value: string }>("SELECT value FROM settings WHERE key = ?", [SETTING_BRANDING]);
  let stored: Partial<BrandingFields> = {};
  try {
    if (row) stored = JSON.parse(row.value) as Partial<BrandingFields>;
  } catch {
    stored = {};
  }
  const fields = { ...DEFAULTS, ...stored };
  const rows = await db.all<{ kind: string; mime: string; hash: string; size: number }>(
    "SELECT kind, mime, hash, size FROM branding_assets ORDER BY kind",
  );
  const assets: Branding["assets"] = {};
  for (const r of rows) {
    const k = r.kind as AssetKind;
    if (ASSET_KINDS.includes(k)) assets[k] = { kind: k, mime: r.mime, hash: r.hash, size: Number(r.size) };
  }
  const etag = (await sha256Hex(JSON.stringify([fields, ASSET_KINDS.map((k) => assets[k]?.hash ?? "")]))).slice(0, 20);
  return { fields, assets, etag };
}

/** Validates a partial write over `cur`; 422 with per-field codes. */
export function parseFields(body: Record<string, unknown>, cur: BrandingFields): BrandingFields {
  const out: BrandingFields = { ...cur };
  const fields: Record<string, string> = {};
  for (const k of ["product_name", "login_headline", "login_subtitle", "support_url", "support_email"] as const) {
    const v = body[k];
    if (v === undefined) continue;
    if (typeof v !== "string") fields[k] = "must_be_string";
    else if (v.trim().length > LIMITS[k]) fields[k] = "too_long";
    else if ([...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) fields[k] = "invalid_characters";
    else out[k] = v.trim();
  }
  if (out.support_url && body.support_url !== undefined) {
    let ok = false;
    try {
      const u = new URL(out.support_url);
      ok = (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
    } catch {
      ok = false;
    }
    if (!ok) fields.support_url = "must_be_http_url";
  }
  if (out.support_email && body.support_email !== undefined && !EMAIL_RE.test(out.support_email)) fields.support_email = "must_be_email";
  if (body.accent !== undefined) {
    if (typeof body.accent !== "string" || (body.accent !== "" && !isHex(body.accent))) fields.accent = "must_be_hex";
    else out.accent = body.accent.toLowerCase();
  }
  if (body.hide_powered_by !== undefined) {
    if (typeof body.hide_powered_by === "boolean") out.hide_powered_by = body.hide_powered_by;
    else fields.hide_powered_by = "must_be_boolean";
  }
  if (body.radius !== undefined) {
    if ((RADII as readonly unknown[]).includes(body.radius)) out.radius = body.radius as Radius;
    else fields.radius = "invalid_choice";
  }
  if (body.tint !== undefined) {
    if ((TINTS as readonly unknown[]).includes(body.tint)) out.tint = body.tint as Tint;
    else fields.tint = "invalid_choice";
  }
  for (const k of Object.keys(body)) {
    if (!(k in DEFAULTS)) fields[k] = "unknown_field";
  }
  if (Object.keys(fields).length > 0) throw invalid(fields);
  return out;
}

export function fieldsStmt(f: BrandingFields): Stmt {
  return {
    sql: "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [SETTING_BRANDING, JSON.stringify(f)],
  };
}

export const resetStmts = (): Stmt[] => [
  { sql: "DELETE FROM settings WHERE key = ?", args: [SETTING_BRANDING] },
  { sql: "DELETE FROM branding_assets" },
];

const paletteView = (p: AccentPalette) => ({ accent: p.accent, hover: p.hover, on_accent: p.onAccent, soft: p.soft, pale: p.pale });

/** The public, display-only view (GET /api/branding). */
export function brandingView(b: Branding) {
  const f = b.fields;
  const derived = f.accent ? deriveAccent(f.accent) : null;
  const url = (k: AssetKind) => {
    const a = b.assets[k];
    return a ? `/api/branding/assets/${k}?v=${a.hash.slice(0, 16)}` : null;
  };
  return {
    product_name: f.product_name,
    accent: f.accent,
    accent_adjusted: derived?.adjusted ?? false,
    palette: derived ? { light: paletteView(derived.light), dark: paletteView(derived.dark) } : null,
    logo_light_url: url("logo-light"),
    logo_dark_url: url("logo-dark"),
    icon_url: url("icon"),
    login_headline: f.login_headline,
    login_subtitle: f.login_subtitle,
    support_url: f.support_url,
    support_email: f.support_email,
    hide_powered_by: f.hide_powered_by,
    radius: f.radius,
    tint: f.tint,
    etag: b.etag,
  };
}

/**
 * Token overrides for index.html's <link rel="stylesheet" href="/api/branding/theme.css">.
 * `html:root` and `html.dark:root` outrank the bundle's `:root` and `.dark` whatever the link
 * order. Every value is a validated hex or a constant, so nothing user-typed reaches the CSS.
 */
export function themeCss(f: BrandingFields): string {
  const light: string[] = [];
  const dark: string[] = [];
  if (f.accent && isHex(f.accent)) {
    const d = deriveAccent(f.accent);
    light.push(cssDecls(paletteVars(d.light)));
    dark.push(cssDecls(paletteVars(d.dark)));
  }
  if (f.radius !== "default") light.push(cssDecls(RADIUS_VARS[f.radius]));
  if (f.tint !== "neutral") {
    light.push(cssDecls(TINT_VARS[f.tint].light));
    dark.push(cssDecls(TINT_VARS[f.tint].dark));
  }
  let css = "/* Runtime Web branding */\n";
  if (light.length) css += `html:root{${light.join("")}}\n`;
  if (dark.length) css += `html.dark:root{${dark.join("")}}\n`;
  return css;
}
