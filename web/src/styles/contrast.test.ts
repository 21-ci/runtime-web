import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const css = readFileSync(resolve(root, "src/index.css"), "utf8");
const buttonSrc = readFileSync(resolve(root, "src/components/ui/button.tsx"), "utf8");
const badgeSrc = readFileSync(resolve(root, "src/components/ui/badge.tsx"), "utf8");

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
  { name: "primary button", fg: "on-primary", bg: "blue" },
  { name: "danger button", fg: "danger-text", bg: "danger-soft" },
  { name: "success badge", fg: "on-success", bg: "green" },
  { name: "info badge", fg: "text", bg: "blue-soft" },
  { name: "danger badge", fg: "danger-text", bg: "danger-soft" },
] as const;

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
    expect(buttonSrc).toMatch(/default:\s*"[^"]*bg-blue[^"]*text-on-primary/);
    expect(buttonSrc).toMatch(/danger:\s*"[^"]*bg-danger-soft[^"]*text-danger-text/);
    expect(badgeSrc).toMatch(/success:\s*"[^"]*bg-green[^"]*text-on-success/);
    expect(badgeSrc).toMatch(/info:\s*"[^"]*bg-blue-soft[^"]*text-text/);
    expect(badgeSrc).toMatch(/danger:\s*"[^"]*bg-danger-soft[^"]*text-danger-text/);
  });

  it("defines the dark set once, with no duplicated prefers-color-scheme copy", () => {
    expect(css.match(/\.dark\s*\{/g)?.length).toBe(1);
    expect(css).not.toMatch(/prefers-color-scheme/);
  });
});
