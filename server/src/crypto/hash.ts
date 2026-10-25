// SHA-256, HMAC-SHA-256 and constant-time comparison via WebCrypto (plus a pure
// comparison loop). Strings are UTF-8 encoded before hashing.

export type Bytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();

function toBytes(v: string | Uint8Array): Uint8Array {
  return typeof v === "string" ? enc.encode(v) : v;
}

/** SHA-256 digest bytes. Used for hashed-at-rest tokens (invites, recovery codes, session ids). */
export async function sha256(data: string | Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toBytes(data) as Bytes));
}

/** SHA-256 as lowercase hex. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return hex(await sha256(data));
}

/** HMAC-SHA-256 of msg under key. */
export async function hmacSha256(key: string | Uint8Array, msg: string | Uint8Array): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", toBytes(key) as Bytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, toBytes(msg) as Bytes));
}

/**
 * Compares two strings or byte arrays without early exit on the first differing
 * byte. Unequal lengths return false immediately (lengths are not secret here:
 * every compared value has a fixed public length).
 */
export function constantTimeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const x = toBytes(a);
  const y = toBytes(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Lowercase hex of bytes. */
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
