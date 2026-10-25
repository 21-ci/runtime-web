// Accent palette derived from one brand hex. The console uses the accent as link text on the
// page background, as a button fill under on-primary text, and as text on accent-pale badges,
// so each theme's accent is walked toward black (light) or white (dark) until all three pairs
// reach WCAG AA (4.5:1). Pure, dependency-free functions shared by the server (theme.css) and
// the console's live preview (imported through the web `@shared-branding` alias).

export interface AccentPalette {
  accent: string;
  hover: string;
  onAccent: string;
  soft: string;
  pale: string;
}

export interface DerivedAccent {
  light: AccentPalette;
  dark: AccentPalette;
  /** The light accent had to be darkened to pass AA. */
  adjusted: boolean;
  /** Contrast of the input hex against the light page background. */
  inputContrast: number;
}

export const AA = 4.5;
const LIGHT_BG = "#ffffff";
const DARK_BG = "#191919";
const DARK_ON = "#111111";
const HEX_RE = /^#[0-9a-f]{6}$/i;

type Rgb = [number, number, number];

export const isHex = (s: string): boolean => HEX_RE.test(s);

function rgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
}

/** a mixed toward b by t (0..1). */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

function luminance(hex: string): number {
  const c = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function palette(accent: string, bg: string, on: string, hoverToward: string, softT: number, paleT: number): AccentPalette {
  return {
    accent,
    hover: mix(accent, hoverToward, 0.14),
    onAccent: on,
    soft: mix(accent, bg, softT),
    pale: mix(accent, bg, paleT),
  };
}

function passes(p: AccentPalette, bg: string): boolean {
  return contrast(p.accent, bg) >= AA && contrast(p.accent, p.onAccent) >= AA && contrast(p.accent, p.pale) >= AA;
}

/** Walks `hex` toward `toward` in 2% steps until the palette passes AA on `bg`. */
function fit(hex: string, bg: string, on: string, toward: string, softT: number, paleT: number): { p: AccentPalette; steps: number } {
  for (let i = 0; i <= 50; i++) {
    const p = palette(mix(hex, toward, i * 0.02), bg, on, toward, softT, paleT);
    if (passes(p, bg)) return { p, steps: i };
  }
  return { p: palette(toward, bg, on, toward, softT, paleT), steps: 50 };
}

/** Light and dark accent palettes for `hex` (#rrggbb). */
export function deriveAccent(hex: string): DerivedAccent {
  const base = hex.toLowerCase();
  const light = fit(base, LIGHT_BG, "#ffffff", "#000000", 0.84, 0.92);
  const dark = fit(base, DARK_BG, DARK_ON, "#ffffff", 0.72, 0.8);
  return { light: light.p, dark: dark.p, adjusted: light.steps > 0, inputContrast: contrast(base, LIGHT_BG) };
}
