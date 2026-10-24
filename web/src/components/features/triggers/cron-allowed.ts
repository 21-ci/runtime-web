// planAllowsCron reads the trigger kinds the app's effective limits allow. The plan lists them as
// `allowed_triggers`; when that list is absent the plan does not restrict kinds, so cron is allowed.
export function planAllowsCron(effective: Record<string, unknown>): boolean {
  const kinds = effective.allowed_triggers;
  if (!Array.isArray(kinds)) return true;
  return kinds.includes("cron");
}
