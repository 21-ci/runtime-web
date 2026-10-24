import { describe, expect, it } from "vitest";
import { createSealer, SealError } from "../../src/crypto/seal.ts";

// Fixture produced by the earlier Go backend's sealer (key = bytes 0..31, plain "client-secret").
const GO_KEY = Uint8Array.from({ length: 32 }, (_, i) => i);
const GO_SEALED_B64 = "bcaBaVs1RL1+jp7SuAMLIfmDHyZYern/ffH5JoJHPyF3EIlRNA7lw24=";

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

describe("seal (AES-256-GCM, Go envelope nonce||ciphertext||tag)", () => {
  it("opens a Go-sealed fixture", async () => {
    const s = await createSealer(GO_KEY);
    const plain = await s.open(fromB64(GO_SEALED_B64));
    expect(new TextDecoder().decode(plain)).toBe("client-secret");
  });

  it("round-trips empty, short and long plaintext", async () => {
    const s = await createSealer(GO_KEY);
    for (const text of ["", "client-secret", "x".repeat(4096)]) {
      const sealed = await s.seal(new TextEncoder().encode(text));
      expect(sealed.length).toBe(12 + new TextEncoder().encode(text).length + 16);
      const got = await s.open(sealed);
      expect(new TextDecoder().decode(got)).toBe(text);
    }
  });

  it("rejects any flipped byte and truncated input with SealError", async () => {
    const s = await createSealer(GO_KEY);
    const sealed = await s.seal(new TextEncoder().encode("default-key-material"));
    for (let i = 0; i < sealed.length; i++) {
      const bad = sealed.slice();
      bad[i] = (bad[i] ?? 0) ^ 0x01;
      await expect(s.open(bad)).rejects.toBeInstanceOf(SealError);
    }
    await expect(s.open(sealed.slice(0, 4))).rejects.toBeInstanceOf(SealError);
  });

  it("uses a fresh nonce per seal", async () => {
    const s = await createSealer(GO_KEY);
    const plain = new TextEncoder().encode("same plaintext");
    const a = await s.seal(plain);
    const b = await s.seal(plain);
    expect(a.slice(0, 12)).not.toEqual(b.slice(0, 12));
    expect(a).not.toEqual(b);
  });

  it("rejects keys that are not 32 bytes", async () => {
    await expect(createSealer(new Uint8Array(16))).rejects.toThrow(/32 bytes/);
  });
});
