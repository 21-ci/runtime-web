// Cookie names, Set-Cookie serialisation and Cookie reading (api-web §1.2, design D12).
// Production cookies are `__Host-` prefixed (HttpOnly; Secure; SameSite=Lax; Path=/;
// no Domain). With `insecure` (RTWEB_INSECURE_COOKIES=1, local http only) the prefix
// and Secure are dropped, nothing else changes.

export interface CookieMode {
  /** True drops the `__Host-` prefix and `Secure` (local development over http). */
  insecure: boolean;
}

export const sessionCookieName = (m: CookieMode): string => (m.insecure ? "rtw_session" : "__Host-rtw_session");

/** Holds the OAuth state + PKCE verifier for 10 minutes (api-web §OAuth). */
export const oauthStateCookieName = (m: CookieMode): string => (m.insecure ? "rtw_oauth" : "__Host-rtw_oauth");

export interface SetCookieOpts extends CookieMode {
  maxAgeSeconds: number;
}

/** Serialises a Set-Cookie header value with the console's attributes. */
export function setCookie(name: string, value: string, opts: SetCookieOpts): string {
  return `${name}=${value}; Max-Age=${Math.floor(opts.maxAgeSeconds)}${baseAttrs(opts)}`;
}

/** Set-Cookie that expires `name` immediately (same name, path and flags so the browser matches it). */
export function clearCookie(name: string, mode: CookieMode): string {
  return `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${baseAttrs(mode)}`;
}

function baseAttrs(mode: CookieMode): string {
  return `; Path=/; HttpOnly${mode.insecure ? "" : "; Secure"}; SameSite=Lax`;
}

/**
 * Reads one cookie from the request's Cookie header. Returns undefined when absent.
 * Values are percent-decoded when valid; a malformed escape is returned as-is.
 */
export function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    const raw = part.slice(i + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}
