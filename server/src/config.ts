// Runtime configuration from env vars / secrets (design §1 D9, D12; api-web §1.2).
// Read once per task and validated fail-closed: a bad config throws ConfigError
// before any request is served. Pass `(name) => Deno.env.get(name)` in main.ts,
// a plain object lookup in tests. Nothing here touches the runtime globals.

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface Config {
  /** Console origin, normalised ("https://console.example.com", no path or trailing slash). Compared to `Origin` on unsafe methods. */
  readonly origin: string;
  /** 32-byte AES-256-GCM key for sealing secrets at rest (RTWEB_SEAL_KEY, base64). */
  readonly sealKey: Uint8Array;
  /** Dev/local only: cookies drop `__Host-` and `Secure` (RTWEB_INSECURE_COOKIES=1). */
  readonly insecureCookies: boolean;
  /** First-run setup token (RTWEB_SETUP_TOKEN). Undefined: setup refuses with 403 until one is set. */
  readonly setupToken: string | undefined;
  /**
   * Apps origin (RTWEB_APPS_URL; RTWEB_RUNTIME_PUBLIC_URL is the deprecated name), e.g. https://apps.example.com: every App is served at
   * https://<slug>.apps.example.com/ (the node's routing.base_domain is the same host). "" (development only) keeps
   * app URLs relative, /s/<slug>/.
   */
  readonly runtimePublicUrl: string;
  /** Runtime plan for new org tenants (RTWEB_DEFAULT_PLAN, default "free"). */
  readonly defaultPlan: string;
}

export type Getenv = (name: string) => string | undefined;

/**
 * Parses and validates the environment. Throws ConfigError naming the bad variable; `warn` gets non-fatal notes
 * (deprecated names, risky setups).
 */
export function loadConfig(getenv: Getenv, warn: (msg: string) => void = (m) => console.warn(`config: ${m}`)): Config {
  const insecureCookies = getenv("RTWEB_INSECURE_COOKIES") === "1";
  const origin = parseOrigin(getenv("RTWEB_ORIGIN"), insecureCookies);
  const sealKey = parseSealKey(getenv("RTWEB_SEAL_KEY"));
  const setupToken = getenv("RTWEB_SETUP_TOKEN") || undefined;
  // RTWEB_APPS_URL is the one name; RTWEB_RUNTIME_PUBLIC_URL is the deprecated earlier one.
  let appsRaw = getenv("RTWEB_APPS_URL");
  if (!appsRaw && getenv("RTWEB_RUNTIME_PUBLIC_URL")) {
    appsRaw = getenv("RTWEB_RUNTIME_PUBLIC_URL");
    warn("RTWEB_RUNTIME_PUBLIC_URL is deprecated: use RTWEB_APPS_URL");
  }
  const runtimePublicUrl = parsePublicUrl(appsRaw);
  // Fail closed: without an apps origin App URLs fall back to the console origin's /s/ paths.
  if (!runtimePublicUrl && !insecureCookies) {
    throw new ConfigError("RTWEB_APPS_URL: required (the apps origin, e.g. https://apps.example.com); empty only with RTWEB_INSECURE_COOKIES=1 for development");
  }
  // App code served on the console origin could call /api with a signed-in admin's cookies.
  if (runtimePublicUrl && new URL(runtimePublicUrl).origin === origin) {
    throw new ConfigError("RTWEB_APPS_URL: must not share the console origin (RTWEB_ORIGIN); serve Apps on their own host");
  }
  if (runtimePublicUrl) {
    const u = new URL(runtimePublicUrl);
    if (u.pathname !== "/" && u.pathname !== "") throw new ConfigError("RTWEB_APPS_URL: must be an origin (no path): Apps live at <slug>.<host>");
    // An App at <slug>.<apps host> must never be the console: the console host may not sit under the apps host.
    if (new URL(origin).hostname.endsWith(`.${u.hostname}`)) {
      throw new ConfigError("RTWEB_APPS_URL: the console host must not be a subdomain of the apps host");
    }
  }
  const defaultPlan = getenv("RTWEB_DEFAULT_PLAN") || "free";
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(defaultPlan)) {
    throw new ConfigError("RTWEB_DEFAULT_PLAN: must be a runtime plan name (lowercase letters, digits, - and _)");
  }
  return { origin, sealKey, insecureCookies, setupToken, runtimePublicUrl, defaultPlan };
}

function parseOrigin(raw: string | undefined, insecure: boolean): string {
  if (!raw) throw new ConfigError("RTWEB_ORIGIN: required (console origin, e.g. https://console.example.com)");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError("RTWEB_ORIGIN: must be an absolute URL");
  }
  const bare = u.pathname === "/" || u.pathname === "";
  if (!bare || u.search || u.hash || u.username || u.password) {
    throw new ConfigError("RTWEB_ORIGIN: must be an origin only (no path, query, fragment or credentials)");
  }
  if (u.protocol !== "https:" && !(insecure && u.protocol === "http:")) {
    throw new ConfigError("RTWEB_ORIGIN: must use https (http only with RTWEB_INSECURE_COOKIES=1)");
  }
  return u.origin;
}

function parseSealKey(raw: string | undefined): Uint8Array {
  if (!raw) throw new ConfigError("RTWEB_SEAL_KEY: required (32 random bytes, base64)");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  } catch {
    throw new ConfigError("RTWEB_SEAL_KEY: not valid base64");
  }
  if (bytes.length !== 32) throw new ConfigError("RTWEB_SEAL_KEY: must decode to 32 bytes");
  return bytes;
}

function parsePublicUrl(raw: string | undefined): string {
  if (!raw) return "";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError("RTWEB_APPS_URL: must be an absolute URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ConfigError("RTWEB_APPS_URL: must use http or https");
  if (u.search || u.hash || u.username || u.password) {
    throw new ConfigError("RTWEB_APPS_URL: no query, fragment or credentials");
  }
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}
