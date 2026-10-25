// The last org the user opened scopes the shell on pages outside an org (instance admin), so the
// org switcher, projects and ⌘K stay where the user left them. Per-viewer convenience only.
const LAST_ORG_KEY = "rt-last-org";

export function readLastOrg(): string | null {
  try {
    return localStorage.getItem(LAST_ORG_KEY);
  } catch {
    return null;
  }
}

export function writeLastOrg(org: string) {
  try {
    localStorage.setItem(LAST_ORG_KEY, org);
  } catch {
    // Storage blocked: pages outside an org fall back to the first org.
  }
}

// pickOrg returns the remembered org when the user still belongs to it, else their first org.
// It answers null while the org list loads, so a stale slug never reaches an org-scoped request.
export function pickOrg(orgs: { slug: string }[] | undefined, last: string | null): string | null {
  if (!orgs) return null;
  if (last && orgs.some((o) => o.slug === last)) return last;
  return orgs[0]?.slug ?? null;
}
