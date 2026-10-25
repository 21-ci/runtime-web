// Seams this module needs from other tasks, injected through Deps (app.ts).
// `apps` is implemented by the apps task (runtime service lookup for an org's app slug);
// `txt` defaults to DNS-over-HTTPS (doh.ts) and is replaced by a fake in tests.

export interface AppRef {
  /** Runtime service id (svc_…). */
  serviceId: string;
  /** App slug as the console shows it. */
  slug: string;
  /** Project the app belongs to (authz scope). */
  projectSlug: string;
}

export interface AppLookup {
  /** Resolves an app of org; null when the org has no app with that slug. */
  resolve(orgId: string, slug: string): Promise<AppRef | null>;
}

/** TXT record values at a DNS name. Empty when the name has none. */
export type TxtLookup = (name: string) => Promise<string[]>;
