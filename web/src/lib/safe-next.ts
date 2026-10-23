// safeNext keeps only same-origin, single-slash paths from a ?next= value, so the sign-in flow
// cannot be used as an open redirect. Anything else falls back to "/". Control characters and
// backslashes are rejected both raw and percent-decoded, because browsers strip or treat them
// as slashes ("/\evil.com", "/\tevil.com").
function hasUnsafe(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x5c) return true;
  }
  return false;
}

export function safeNext(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return "/";
  if (hasUnsafe(value)) return "/";

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return "/";
  }
  if (hasUnsafe(decoded)) return "/";
  if (!decoded.startsWith("/") || decoded.startsWith("//")) return "/";

  const origin = window.location.origin;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return "/";
  }
  if (url.origin !== origin || !url.pathname.startsWith("/") || url.pathname.startsWith("//")) return "/";
  return value;
}
