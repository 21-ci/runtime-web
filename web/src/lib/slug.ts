import { i18n } from "./i18n";

// Mirrors the server's slug rule: the slug becomes a DNS label (<slug>.<apps domain>).
export const SLUG_RE = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const MAX_SLUG = 63;

/** What is wrong with a non-empty slug, in words that say how to fix it; null when it is valid. */
export function slugError(slug: string): string | null {
  const bad = [...new Set(slug.replace(/[a-z0-9-]/g, ""))];
  if (bad.length > 0) return i18n.t("apps:new.slugChars", { chars: bad.join(", ") });
  if (slug.length > MAX_SLUG) return i18n.t("apps:new.slugLong", { max: MAX_SLUG });
  if (slug.startsWith("-") || slug.endsWith("-")) return i18n.t("apps:new.slugEdge");
  if (slug.includes("--")) return i18n.t("apps:new.slugDouble");
  return null;
}

/** The runtime labels a branch's environment `br-<name>` when none is given, and removes it with the branch. */
export const isBranchEnvironment = (environment: string) => environment.startsWith("br-");
