// TXT and address lookups over DNS-over-HTTPS: the guest runtime has no resolver (design D1/§3).
// NXDOMAIN is an empty answer; any other DoH failure throws (callers count it as a miss).

import type { TxtLookup } from "./types.ts";

export const DOH_URL = "https://cloudflare-dns.com/dns-query";
const TXT_TYPE = 16;
const A_TYPE = 1;
const AAAA_TYPE = 28;
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

/** Resolves a host name to its A and AAAA addresses. */
export type AddrLookup = (name: string) => Promise<string[]>;

/** A and AAAA lookups; NXDOMAIN is an empty list, any other failure throws. CNAME chains come back flattened. */
export function dohAddrs(fetchFn: typeof fetch = fetch, timeoutMs = 5_000): AddrLookup {
  const one = async (name: string, type: "A" | "AAAA", want: number): Promise<string[]> => {
    const res = await fetchFn(`${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`doh: http ${res.status}`);
    const body = (await res.json()) as DohAnswer;
    if (body.Status === NXDOMAIN) return [];
    if (body.Status !== NOERROR) throw new Error(`doh: status ${body.Status ?? "?"}`);
    return (body.Answer ?? []).filter((a) => a.type === want && typeof a.data === "string").map((a) => a.data as string);
  };
  return async (name) => {
    const [v4, v6] = await Promise.all([one(name, "A", A_TYPE), one(name, "AAAA", AAAA_TYPE)]);
    return [...v4, ...v6];
  };
}
