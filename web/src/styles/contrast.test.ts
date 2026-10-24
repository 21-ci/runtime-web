import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const css = readFileSync(resolve(root, "src/index.css"), "utf8");
const buttonSrc = readFileSync(resolve(root, "src/components/ui/button.tsx"), "utf8");
const badgeSrc = readFileSync(resolve(root, "src/components/ui/badge.tsx"), "utf8");
const iconTileSrc = readFileSync(resolve(root, "src/components/ui/icon-tile.tsx"), "utf8");

/** Returns the body of the first rule whose selector is exactly `selector`. */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`index.css: no ${selector} block`);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

function tokens(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block(selector).matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Each pair: [component, text token, background token]. Used by a component class.
const pairs = [
  { name: "primary button", fg: "on-primary", bg: "accent" },
  { name: "primary button hover", fg: "on-primary", bg: "accent-hover" },
  { name: "body text", fg: "text", bg: "bg" },
  { name: "body text on surface", fg: "text", bg: "surface" },
  { name: "muted text", fg: "muted", bg: "bg" },
  { name: "muted text on surface", fg: "muted", bg: "surface" },
  { name: "muted text on panel-2", fg: "muted", bg: "panel-2" },
  { name: "accent link", fg: "accent", bg: "surface" },
  { name: "accent link on bg", fg: "accent", bg: "bg" },
  { name: "selected nav", fg: "text", bg: "accent-pale" },
  { name: "danger text", fg: "danger-text", bg: "surface" },
  { name: "danger button", fg: "danger-text", bg: "danger-soft" },
  { name: "success solid", fg: "on-success", bg: "green" },
  { name: "info badge", fg: "text", bg: "accent-soft" },
  { name: "danger text on panel", fg: "danger-text", bg: "panel" },
  { name: "muted text on panel", fg: "muted", bg: "panel" },
  { name: "secondary button", fg: "text", bg: "secondary" },
  { name: "secondary button hover", fg: "text", bg: "secondary-hover" },
  { name: "muted on secondary (tabs, search)", fg: "muted", bg: "secondary" },
  { name: "input text", fg: "text", bg: "field" },
  { name: "input placeholder", fg: "muted", bg: "field" },
  { name: "accent link on panel", fg: "accent", bg: "panel" },
  { name: "text on accent-soft selection", fg: "text", bg: "accent-soft" },
  { name: "body text on surface-2", fg: "text", bg: "surface-2" },
  { name: "muted text on surface-2", fg: "muted", bg: "surface-2" },
  { name: "solid danger button", fg: "on-danger", bg: "danger" },
  { name: "danger text on bg", fg: "danger-text", bg: "bg" },
  ...["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red", "teal"].map((c) => ({
    name: `${c} tag`,
    fg: `tag-${c}-text`,
    bg: `tag-${c}-bg`,
  })),
];

describe("contrast: WCAG AA (4.5:1) for filled controls and badges", () => {
  for (const theme of [
    { label: "light", selector: ":root" },
    { label: "dark", selector: ".dark" },
  ]) {
    it(`meets 4.5:1 in ${theme.label} theme`, () => {
      const t = tokens(theme.selector);
      for (const p of pairs) {
        const fg = t[p.fg];
        const bg = t[p.bg];
        expect(fg, `${theme.label}: --${p.fg} missing`).toBeDefined();
        expect(bg, `${theme.label}: --${p.bg} missing`).toBeDefined();
        expect(contrast(fg, bg), `${theme.label} ${p.name}: --${p.fg} on --${p.bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it("components use the token pairs that were checked", () => {
    expect(buttonSrc).toMatch(/default:\s*"[^"]*bg-accent[^"]*text-on-primary/);
    expect(buttonSrc).toMatch(/secondary:\s*"[^"]*bg-surface-2[^"]*text-text/);
    expect(buttonSrc).toMatch(/"danger-solid":\s*"[^"]*bg-danger[^"]*text-on-danger/);
    expect(buttonSrc).toMatch(/rounded-md/);
    expect(iconTileSrc).toMatch(/teal:\s*"bg-tag-teal-bg text-tag-teal-text"/);
    expect(buttonSrc).toMatch(/danger:\s*"[^"]*bg-danger-soft[^"]*text-danger-text/);
    expect(badgeSrc).toMatch(/success:\s*"[^"]*bg-tag-green-bg[^"]*text-tag-green-text/);
    expect(badgeSrc).toMatch(/info:\s*"[^"]*bg-accent-soft[^"]*text-text/);
    expect(badgeSrc).toMatch(/danger:\s*"[^"]*bg-tag-red-bg[^"]*text-tag-red-text/);
    expect(badgeSrc).not.toMatch(/bg-green\b|text-on-success/);
  });

  it("keeps dark mode neutral: equal channels on the base surfaces (no blue or brown tint)", () => {
    const t = tokens(".dark");
    for (const k of ["bg", "panel", "panel-2", "surface", "surface-2"]) {
      const hex = t[k];
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      expect(r, `--${k} ${hex}`).toBe(g);
      expect(g, `--${k} ${hex}`).toBe(b);
    }
    // Elevation steps go up: canvas < chrome <= raised.
    expect(parseInt(t.bg.slice(1, 3), 16)).toBeLessThan(parseInt(t.panel.slice(1, 3), 16));
    expect(parseInt(t.surface.slice(1, 3), 16)).toBeLessThanOrEqual(parseInt(t["surface-2"].slice(1, 3), 16));
  });

  it("defines the dark set once, with no duplicated prefers-color-scheme copy", () => {
    expect(css.match(/\.dark\s*\{/g)?.length).toBe(1);
    expect(css).not.toMatch(/prefers-color-scheme/);
  });
});
