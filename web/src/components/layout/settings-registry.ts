// SETTINGS_REGISTRY lists the settings pages the ⌘K menu can jump to. Paths use $org for the
// current org. An entry is shown only when its route exists in the router, so pages that land
// later (settings in Tasks 14f and 15) appear in the menu by being added to the file tree,
// not by editing this list's consumers.
export type SettingsEntry = { label: string; path: string };

export const SETTINGS_REGISTRY: SettingsEntry[] = [
  { label: "Organization settings", path: "/$org/settings/general" },
  { label: "Members", path: "/$org/settings/members" },
  { label: "Tokens", path: "/$org/settings/tokens" },
  { label: "Audit log", path: "/$org/settings/audit" },
  { label: "Account security", path: "/me/security" },
  { label: "Admin: users", path: "/admin/users" },
  { label: "Admin: organizations", path: "/admin/orgs" },
  { label: "Admin: audit log", path: "/admin/audit" },
  { label: "Admin: node", path: "/admin/node" },
  { label: "Admin: cache", path: "/admin/cache" },
  { label: "Admin: domains", path: "/admin/domains" },
  { label: "Admin: instance settings", path: "/admin/settings" },
];
