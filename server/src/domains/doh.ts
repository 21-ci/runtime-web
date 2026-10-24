// TXT lookups over DNS-over-HTTPS: the guest runtime has no resolver (design D1/§3).
// NXDOMAIN is an empty answer; any other DoH failure throws (callers count it as a miss).

import type { TxtLookup } from "./types.ts";

export const DOH_URL = "https://cloudflare-dns.com/dns-query";
const TXT_TYPE = 16;
const NOERROR = 0;
const NXDOMAIN = 3;

interface DohAnswer {
  Status?: number;
  Answer?: { type?: number; data?: string }[];
}

/** Joins the quoted character-strings of one TXT record ("a" "b" → "ab"). */
export function txtData(raw: string): string {
  const parts = [...raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? "").replace(/\\(.)/g, "$1"));
  return parts.length > 0 ? parts.join("") : raw;
}

export function dohTxt(fetchFn: typeof fetch = fetch, timeoutMs = 5_000): TxtLookup {
  return async (name) => {
    const res = await fetchFn(`${DOH_URL}?name=${encodeURIComponent(name)}&type=TXT`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`doh: http ${res.status}`);
    const body = (await res.json()) as DohAnswer;
    if (body.Status === NXDOMAIN) return [];
    if (body.Status !== NOERROR) throw new Error(`doh: status ${body.Status ?? "?"}`);
    return (body.Answer ?? []).filter((a) => a.type === TXT_TYPE && typeof a.data === "string").map((a) => txtData(a.data as string));
  };
}
