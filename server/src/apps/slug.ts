// The one App slug rule. Slugs become DNS labels (<slug>.<apps domain>): lowercase letters, digits and `-`,
// 1..63 characters, no leading or trailing `-` and no `--` (reserved for punycode-like labels). Used by the create
// route, tls-ask and the new-app form (mirror it there).

export const SLUG_RE = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isSlug(s: string): boolean {
  return SLUG_RE.test(s);
}
