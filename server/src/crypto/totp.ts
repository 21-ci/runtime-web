// RFC 4226 HOTP / RFC 6238 TOTP (HMAC-SHA-1, 6 digits, 30 s step, +-1 step skew
// as in internal/auth/totp.go) plus base32 (RFC 4648, unpadded) for authenticator
// enrollment. WebCrypto only.

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted either side of "now". */
export const TOTP_SKEW = 1;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4226 HOTP value for counter, as a zero-padded decimal string. */
export async function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-1" }, false, [
    "sign",
  ]);
  const msg = new Uint8Array(8);
  // Counter as 64-bit big-endian; JS numbers are exact to 2^53, far beyond any time step.
  new DataView(msg.buffer).setBigUint64(0, BigInt(Math.floor(counter)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = (mac[mac.length - 1] ?? 0) & 0x0f;
  const v =
    (((mac[off] ?? 0) & 0x7f) << 24) |
    ((mac[off + 1] ?? 0) << 16) |
    ((mac[off + 2] ?? 0) << 8) |
    (mac[off + 3] ?? 0);
  return String(v % 10 ** digits).padStart(digits, "0");
}

/** TOTP for the time step containing timeMs (milliseconds since epoch). */
export async function totp(
  secret: Uint8Array,
  timeMs: number,
  opts: { digits?: number; periodSeconds?: number } = {},
): Promise<string> {
  const step = Math.floor(timeMs / 1000 / (opts.periodSeconds ?? TOTP_PERIOD_SECONDS));
  return hotp(secret, step, opts.digits ?? TOTP_DIGITS);
}

/**
 * Checks a 6-digit code against the steps within TOTP_SKEW of timeMs. Returns the
 * matched step counter (callers store it to reject replays) or null. Shape is not
 * validated here: callers reject non-digit input first.
 */
export async function verifyTotp(secret: Uint8Array, code: string, timeMs: number): Promise<number | null> {
  const step = Math.floor(timeMs / 1000 / TOTP_PERIOD_SECONDS);
  for (let d = -TOTP_SKEW; d <= TOTP_SKEW; d++) {
    const s = step + d;
    if (s < 0) continue;
    if ((await hotp(secret, s)) === code) return s;
  }
  return null;
}

/** RFC 4648 base32, no padding (authenticator secrets). */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(buf >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buf &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(buf << (5 - bits)) & 31];
  return out;
}

/** Inverse of base32Encode; accepts upper/lower case, ignores padding and spaces. Throws on invalid input. */
export function base32Decode(s: string): Uint8Array {
  const clean = s.replace(/[\s=]/g, "").toUpperCase();
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("base32: invalid character");
    buf = (buf << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((buf >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    buf &= (1 << bits) - 1;
  }
  return Uint8Array.from(out);
}

/**
 * otpauth:// URI for authenticator apps, parameters in the same order and encoding
 * as Go url.Values.Encode (sorted keys, "+" for spaces).
 */
export function otpauthUri(issuer: string, account: string, secret: Uint8Array): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account).replaceAll("%40", "@")}`;
  const q = new URLSearchParams([
    ["algorithm", "SHA1"],
    ["digits", String(TOTP_DIGITS)],
    ["issuer", issuer],
    ["period", String(TOTP_PERIOD_SECONDS)],
    ["secret", base32Encode(secret)],
  ]);
  return `otpauth://totp/${label}?${q.toString()}`;
}
