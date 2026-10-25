// Random bytes, tokens and prefixed ids. Uses WebCrypto getRandomValues only.

/** n cryptographically random bytes. */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** Unpadded base64url of n random bytes (32 bytes -> 43 chars). Session ids, invite tokens, CSRF. */
export function randomToken(n = 32): string {
  return base64url(randomBytes(n));
}

/** 2n lowercase hex chars from n random bytes (setup token: randomHex(24) = 48 chars). */
export function randomHex(n: number): string {
  return Array.from(randomBytes(n), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Unpadded base64url encoding. */
export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Prefixed ULID (`usr_01H...`, 26 Crockford chars: 48-bit ms time + 80 random bits).
 * `now` defaults to Date.now(); pass it in tests and where the clock is frozen.
 */
export function newId(prefix: string, now: number = Date.now()): string {
  let t = Math.floor(now);
  const timeChars = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = CROCKFORD[t % 32] ?? "0";
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(16);
  let bits = 0n;
  for (let i = 0; i < 10; i++) bits = (bits << 8n) | BigInt(rand[i] ?? 0);
  const randChars = new Array<string>(16);
  for (let i = 15; i >= 0; i--) {
    randChars[i] = CROCKFORD[Number(bits & 31n)] ?? "0";
    bits >>= 5n;
  }
  return `${prefix}_${timeChars.join("")}${randChars.join("")}`;
}
