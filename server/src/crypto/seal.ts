// AES-256-GCM sealing of secrets at rest.
//
// Envelope, byte-compatible with the earlier Go backend: nonce(12) || ciphertext || tag(16).
// No version prefix; store the bytes as a BLOB. Open fails with SealError on any
// truncation or authentication failure, never with a partial plaintext.

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class SealError extends Error {
  constructor() {
    super("seal: open failed");
    this.name = "SealError";
  }
}

export interface Sealer {
  /** Encrypts plain under a fresh random nonce. */
  seal(plain: Uint8Array): Promise<Uint8Array>;
  /** Decrypts an envelope from seal. Throws SealError. */
  open(sealed: Uint8Array): Promise<Uint8Array>;
}

/** Imports a 32-byte key (RTWEB_SEAL_KEY decoded). Throws if the length is wrong. */
export async function createSealer(key: Uint8Array): Promise<Sealer> {
  if (key.length !== 32) throw new Error("seal: key must be 32 bytes");
  const k = await crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  return {
    async seal(plain) {
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, k, plain as Uint8Array<ArrayBuffer>),
      );
      const out = new Uint8Array(NONCE_BYTES + ct.length);
      out.set(nonce, 0);
      out.set(ct, NONCE_BYTES);
      return out;
    },
    async open(sealed) {
      if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new SealError();
      const nonce = sealed.subarray(0, NONCE_BYTES);
      const body = sealed.subarray(NONCE_BYTES);
      try {
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: nonce as Uint8Array<ArrayBuffer>, tagLength: 128 },
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
