// SETTINGS_REGISTRY lists the settings pages the ⌘K menu can jump to. Paths use $org for the
// current org. An entry is shown only when its route exists in the router, so pages that land
// later (settings in Tasks 14f and 15) appear in the menu by being added to the file tree,
// not by editing this list's consumers.
// Entries flagged admin are instance-admin pages, shown only when /api/me says instance admin.
export type SettingsEntry = { label: string; path: string; admin?: boolean };

export const SETTINGS_REGISTRY: SettingsEntry[] = [
  { label: "Organization settings", path: "/$org/settings/general" },
  { label: "Members", path: "/$org/settings/members" },
  { label: "Tokens", path: "/$org/settings/tokens" },
  { label: "Audit log", path: "/$org/settings/audit" },
  { label: "Account security", path: "/me/security" },
  { label: "Admin: users", path: "/admin/users", admin: true },
  { label: "Admin: organizations", path: "/admin/orgs", admin: true },
  { label: "Admin: audit log", path: "/admin/audit", admin: true },
  { label: "Admin: node", path: "/admin/node", admin: true },
  { label: "Admin: cache", path: "/admin/cache", admin: true },
  { label: "Admin: domains", path: "/admin/domains", admin: true },
  { label: "Admin: instance settings", path: "/admin/settings", admin: true },
];

// visibleSettings keeps entries whose route exists and hides admin entries from non-admins.
export function visibleSettings(
  routes: object,
  isAdmin: boolean,
): SettingsEntry[] {
  return SETTINGS_REGISTRY.filter(
    (e) => e.path in routes && (!e.admin || isAdmin),
  );
}
