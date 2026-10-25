// Security headers on every response (audit M4), set once in createApp.
//
// CSP notes for the console bundle (web/):
// - script-src 'self': no inline scripts (theme-init.js is a file).
// - style-src 'unsafe-inline' is required: CodeMirror (style-mod) and sonner insert
//   <style> elements at runtime. Inline *script* stays forbidden.
// - img-src data: for the TOTP QR code; blob: for the recovery-code download link.
// - worker-src 'self' for the TypeScript language worker (a same-origin module file).
// - frame-src: only the runtime's public app origin, for the App preview. Never 'self': the
//   preview iframe allows scripts, so a same-origin app would run with the console's rights.

const DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
];

/** The console CSP; `appOrigin` (the runtime public URL's origin) may be framed when it is foreign. */
export function cspFor(consoleOrigin: string, appOrigin?: string): string {
  const frame = appOrigin && appOrigin !== consoleOrigin ? appOrigin : "'none'";
  return [...DIRECTIVES, `frame-src ${frame}`].join("; ");
}

/** The CSP with no frameable app origin. */
export const CSP = cspFor("");

const BASE: Record<string, string> = {
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
};

export const HSTS = "max-age=31536000; includeSubDomains";

/** Adds the headers in place (falls back to a copy when the headers are immutable). */
export function withSecurityHeaders(res: Response, origin: string, appOrigin?: string): Response {
  const extra: Record<string, string> = { ...BASE, "content-security-policy": cspFor(origin, appOrigin) };
  if (origin.startsWith("https://")) extra["strict-transport-security"] = HSTS;
  try {
    for (const [k, v] of Object.entries(extra)) if (!res.headers.has(k)) res.headers.set(k, v);
    return res;
  } catch {
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(extra)) if (!h.has(k)) h.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }
}
