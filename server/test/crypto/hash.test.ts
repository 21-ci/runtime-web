import { describe, expect, it } from "vitest";
import { constantTimeEqual, hmacSha256, sha256Hex } from "../../src/crypto/hash.ts";
import { newId, randomBytes, randomHex, randomToken } from "../../src/crypto/random.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("hash", () => {
  it("sha256Hex matches the NIST vector for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hmacSha256 matches RFC 4231 test case 2", async () => {
    const mac = await hmacSha256(enc("Jefe"), enc("what do ya want for nothing?"));
    expect(hex(mac)).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("constantTimeEqual compares bytes and strings", () => {
    expect(constantTimeEqual(enc("abc"), enc("abc"))).toBe(true);
    expect(constantTimeEqual(enc("abc"), enc("abd"))).toBe(false);
    expect(constantTimeEqual(enc("abc"), enc("ab"))).toBe(false);
    expect(constantTimeEqual("token", "token")).toBe(true);
    expect(constantTimeEqual("token", "tokeN")).toBe(false);
  });
});

describe("random", () => {
  it("randomBytes returns the requested length, varying between calls", () => {
    expect(randomBytes(32).length).toBe(32);
    expect(hex(randomBytes(16))).not.toBe(hex(randomBytes(16)));
  });

  it("randomToken is base64url without padding", () => {
    const t = randomToken(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("randomHex yields 2n lowercase hex chars", () => {
    expect(randomHex(24)).toMatch(/^[0-9a-f]{48}$/);
  });

  it("newId is prefix_ + 26-char Crockford ULID, sortable by time", () => {
    const a = newId("usr", 1_700_000_000_000);
    const b = newId("usr", 1_700_000_000_001);
    expect(a).toMatch(/^usr_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(a).not.toBe(newId("usr", 1_700_000_000_000));
  });
});
