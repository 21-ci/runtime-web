import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, otpauthUri, totp, verifyTotp } from "../../src/crypto/totp.ts";

// RFC 6238 Appendix B: SHA-1, secret "12345678901234567890", 8 digits.
const RFC_SECRET = new TextEncoder().encode("12345678901234567890");
const RFC_VECTORS: Array<[number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("totp (RFC 6238)", () => {
  it.each(RFC_VECTORS)("time %i gives %s with 8 digits", async (t, want) => {
    expect(await totp(RFC_SECRET, t * 1000, { digits: 8 })).toBe(want);
  });

  it("defaults to 6 digits and 30 s steps", async () => {
    expect(await totp(RFC_SECRET, 59_000)).toBe("287082");
    expect(await totp(RFC_SECRET, 59_999)).toBe("287082");
    expect(await totp(RFC_SECRET, 60_000)).not.toBe("287082");
  });

  it("hotp matches RFC 4226 Appendix D", async () => {
    expect(await hotp(new TextEncoder().encode("12345678901234567890"), 0, 6)).toBe("755224");
    expect(await hotp(new TextEncoder().encode("12345678901234567890"), 1, 6)).toBe("287082");
  });

  it("verifyTotp accepts the current step and one step either side only", async () => {
    const now = 59_000;
    expect(await verifyTotp(RFC_SECRET, "287082", now)).toBe(1); // step counter of t=59 (1)
    expect(await verifyTotp(RFC_SECRET, "287082", now + 30_000)).toBe(1);
    expect(await verifyTotp(RFC_SECRET, "287082", now + 60_000)).toBeNull();
    expect(await verifyTotp(RFC_SECRET, "000000", now)).toBeNull();
  });
});

describe("base32 and otpauth", () => {
  it("round-trips RFC 4648 vectors without padding", () => {
    const enc = (s: string) => base32Encode(new TextEncoder().encode(s));
    expect(enc("")).toBe("");
    expect(enc("f")).toBe("MY");
    expect(enc("foobar")).toBe("MZXW6YTBOI");
    expect(new TextDecoder().decode(base32Decode("MZXW6YTBOI"))).toBe("foobar");
  });

  it("builds an authenticator URI with SHA1, 6 digits, 30 s", () => {
    const uri = otpauthUri("Runtime Web", "a@example.com", new TextEncoder().encode("foobar"));
    expect(uri).toBe(
      "otpauth://totp/Runtime%20Web:a@example.com?algorithm=SHA1&digits=6&issuer=Runtime+Web&period=30&secret=MZXW6YTBOI",
    );
  });
});
