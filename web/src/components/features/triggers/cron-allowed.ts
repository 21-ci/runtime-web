// planAllowsCron reads the trigger kinds the org's plan allows, as returned by GET /api/orgs/{org}/limits
// (`allowed_triggers`, the runtime plan field). When the list is absent or null (unknown, or a plan that
// does not restrict kinds) cron is allowed; the runtime still answers 403 trigger_not_allowed.
export function planAllowsCron(limits: { allowed_triggers?: unknown } | undefined): boolean {
  const kinds = limits?.allowed_triggers;
  if (!Array.isArray(kinds)) return true;
  return kinds.includes("cron");
}
