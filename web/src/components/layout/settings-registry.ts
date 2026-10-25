// SETTINGS_REGISTRY lists the settings pages the ⌘K menu can jump to. Paths use $org for the
// current org. An entry is shown only when its route exists in the router, so a new settings page
// appears in the menu by being added to the file tree, not by editing this list's consumers.
// Entries flagged admin are instance-admin pages, shown only when /api/me says instance admin.
// labelKey is a key in the `shell` namespace.
export type SettingsEntry = { labelKey: SettingsLabelKey; path: string; admin?: boolean };

type SettingsLabelKey = `settings.${
  | "org"
  | "members"
  | "tokens"
  | "auditLog"
  | "accountSecurity"
  | "instanceUsers"
  | "instanceOrgs"
  | "instanceAudit"
  | "instanceNode"
  | "instanceCache"
  | "instanceDomains"
  | "instanceSettings"}`;

export const SETTINGS_REGISTRY: SettingsEntry[] = [
  { labelKey: "settings.org", path: "/$org/settings/general" },
  { labelKey: "settings.members", path: "/$org/settings/members" },
  { labelKey: "settings.tokens", path: "/$org/settings/tokens" },
  { labelKey: "settings.auditLog", path: "/$org/settings/audit" },
  { labelKey: "settings.accountSecurity", path: "/me/security" },
  { labelKey: "settings.instanceUsers", path: "/admin/users", admin: true },
  { labelKey: "settings.instanceOrgs", path: "/admin/orgs", admin: true },
  { labelKey: "settings.instanceAudit", path: "/admin/audit", admin: true },
  { labelKey: "settings.instanceNode", path: "/admin/node", admin: true },
  { labelKey: "settings.instanceCache", path: "/admin/cache", admin: true },
  { labelKey: "settings.instanceDomains", path: "/admin/domains", admin: true },
  { labelKey: "settings.instanceSettings", path: "/admin/settings", admin: true },
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
