import type { OrgRole } from "@/lib/types";

// Runtime tenant scopes a custom token may carry (docs/00-research-and-design.md §3.3). keys:write
// is never offered: the default key holds it, and a custom token must not mint keys.
export const TOKEN_SCOPES = [
  "services:read",
  "logs:read",
  "services:write",
  "deploy",
  "env:write",
  "queue:write",
  "invoke",
  "secrets:write",
  "data:admin",
  "sockets:write",
] as const;

const READ_ONLY: string[] = ["services:read", "logs:read"];

// scopesForRole limits the picker to what the role may grant. Owners and admins get every scope;
// anyone else gets read scopes only (the tokens page itself is owner and admin only).
export function scopesForRole(role: OrgRole): string[] {
  return role === "owner" || role === "admin" ? [...TOKEN_SCOPES] : [...READ_ONLY];
}

export const EXPIRY_OPTIONS = [
  { value: "never", label: "Never", days: null },
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "90 days", days: 90 },
  { value: "365", label: "1 year", days: 365 },
] as const;
