// Branding image checks. The type comes from the file's magic bytes, never from a client
// header or file name. SVG is the risky one: served same-origin, a script inside it would
// run with the console's rights if a user opened it directly. It is served with a sandbox
// CSP (routes/branding.ts) and, as a second layer, rejected here when it carries anything
// that can execute or load: script, event handlers, foreignObject, entities, non-local refs.

export const MAX_ASSET_BYTES = 512 * 1024;

export const ASSET_KINDS = ["logo-light", "logo-dark", "icon"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const isAssetKind = (s: string): s is AssetKind => (ASSET_KINDS as readonly string[]).includes(s);

export type AssetMime = "image/png" | "image/jpeg" | "image/webp" | "image/x-icon" | "image/svg+xml";

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

/** The image type of `b`, or null when it is not a supported format. */
export function sniff(b: Uint8Array): AssetMime | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (startsWith(b, [0x00, 0x00, 0x01, 0x00]) && b.length > 6) return "image/x-icon";
  const text = svgText(b);
  if (text !== null && startsWithSvgTag(text)) return "image/svg+xml";
  return null;
}

// startsWithSvgTag skips an XML declaration and leading comments, then expects <svg. A linear scan
// instead of a regex like (?:<!--[\s\S]*?-->\s*)*, which backtracks exponentially on crafted input.
function startsWithSvgTag(text: string): boolean {
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i] as string)) i++;
  };
  if (text.startsWith("<?xml", i)) {
    const end = text.indexOf(">", i);
    if (end < 0) return false;
    i = end + 1;
  }
  skipSpace();
  while (text.startsWith("<!--", i)) {
    const end = text.indexOf("-->", i + 4);
    if (end < 0) return false;
    i = end + 3;
    skipSpace();
  }
  return /^<svg[\s>]/i.test(text.slice(i, i + 5));
}

function svgText(b: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b).replace(/^\uFEFF/, "").trimStart();
  } catch {
    return null;
  }
}

const SVG_DENY: readonly RegExp[] = [
  /<\s*script/i,
  /<\s*foreignObject/i,
  /<\s*(?:iframe|embed|object|audio|video|use\b[^>]*href\s*=\s*["'](?!#))/i,
  /<!ENTITY/i,
  /<!DOCTYPE/i,
  /\son[a-z]+\s*=/i,
  /javascript:/i,
  /(?:xlink:)?href\s*=\s*["']\s*(?!#|data:image\/(?:png|jpeg|webp);)/i,
  /@import/i,
  /url\(\s*["']?\s*(?!#)/i,
];

/** Why an SVG is refused, or null when it only draws. */
export function unsafeSvg(b: Uint8Array): string | null {
  const text = svgText(b);
  if (text === null) return "not_utf8";
  return SVG_DENY.some((re) => re.test(text)) ? "svg_active_content" : null;
}
