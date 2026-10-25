// AES-256-GCM sealing of secrets at rest.
//
// Envelope, byte-compatible with the earlier Go backend: nonce(12) || ciphertext || tag(16).
// No version prefix; store the bytes as a BLOB. Open fails with SealError on any
// truncation or authentication failure, never with a partial plaintext.
//
// Callers bind each value to where it lives with a context string used as GCM
// associated data (e.g. "org.default_key:<orgId>"), so a sealed blob copied to another
// row or field fails to open. Values sealed before contexts existed carry no AAD;
// openCompat still accepts them and hands back a context-bound reseal to store.

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class SealError extends Error {
  constructor() {
    super("seal: open failed");
    this.name = "SealError";
  }
}

export interface Sealer {
  /** Encrypts plain under a fresh random nonce, bound to context (AAD) when given. */
  seal(plain: Uint8Array, context?: string): Promise<Uint8Array>;
  /** Decrypts an envelope from seal under the same context. Throws SealError. */
  open(sealed: Uint8Array, context?: string): Promise<Uint8Array>;
}

const aadOf = (context: string | undefined) =>
  context === undefined ? {} : { additionalData: new TextEncoder().encode(context) as Uint8Array<ArrayBuffer> };

/**
 * Opens sealed under context, falling back to a legacy no-AAD envelope. For a legacy
 * value, resealed is the context-bound replacement the caller should store (CAS on the
 * old bytes); otherwise it is null. Throws SealError when neither form opens.
 */
export async function openCompat(
  s: Sealer,
  sealed: Uint8Array,
  context: string,
): Promise<{ plain: Uint8Array; resealed: Uint8Array | null }> {
  try {
    return { plain: await s.open(sealed, context), resealed: null };
  } catch (e) {
    if (!(e instanceof SealError)) throw e;
  }
  const plain = await s.open(sealed);
  return { plain, resealed: await s.seal(plain, context) };
}

/** Imports a 32-byte key (RTWEB_SEAL_KEY decoded). Throws if the length is wrong. */
export async function createSealer(key: Uint8Array): Promise<Sealer> {
  if (key.length !== 32) throw new Error("seal: key must be 32 bytes");
  const k = await crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  return {
    async seal(plain, context) {
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128, ...aadOf(context) }, k, plain as Uint8Array<ArrayBuffer>),
      );
      const out = new Uint8Array(NONCE_BYTES + ct.length);
      out.set(nonce, 0);
      out.set(ct, NONCE_BYTES);
      return out;
    },
    async open(sealed, context) {
      if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new SealError();
      const nonce = sealed.subarray(0, NONCE_BYTES);
      const body = sealed.subarray(NONCE_BYTES);
      try {
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: nonce as Uint8Array<ArrayBuffer>, tagLength: 128, ...aadOf(context) },
          k,
          body as Uint8Array<ArrayBuffer>,
        );
        return new Uint8Array(plain);
      } catch {
        throw new SealError();
      }
    },
  };
}
