import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/crypto/password.ts";

// Produced by Go internal/auth.Argon2{}.Hash("correct horse battery").
const GO_HASH =
  "$argon2id$v=19$m=65536,t=3,p=2$VSqhxuPNyep9IOl0uGtMvA$doVPygo6P9coakYPE0L55D49Cs+2BmQeQvraLGH40zc";

describe("argon2id password hashing", () => {
  it("verifies a Go-generated hash", async () => {
    expect(await verifyPassword(GO_HASH, "correct horse battery")).toBe(true);
    expect(await verifyPassword(GO_HASH, "correct horse batter")).toBe(false);
  }, 30_000);

  it("hashes with the Go parameters and round-trips", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.startsWith("$argon2id$v=19$m=65536,t=3,p=2$")).toBe(true);
    expect(h).not.toMatch(/=\$|=$/); // unpadded base64 like Go's RawStdEncoding
    expect(await verifyPassword(h, "correct horse battery")).toBe(true);
    expect(await hashPassword("correct horse battery")).not.toBe(h); // fresh salt
  }, 30_000);

  it.each([
    ["garbage", "$argon2id$v=19$m=x$y$z"],
    ["wrong algorithm", "$argon2i$v=19$m=65536,t=3,p=2$VSqhxuPNyep9IOl0uGtMvA$doVPygo6P9coakYPE0L55D49Cs"],
    ["wrong version", GO_HASH.replace("v=19", "v=16")],
    ["memory over 1 GiB", GO_HASH.replace("m=65536", "m=2097152")],
    ["zero iterations", GO_HASH.replace("t=3", "t=0")],
    ["empty salt", GO_HASH.replace("VSqhxuPNyep9IOl0uGtMvA", "")],
  ])("rejects %s without throwing", async (_name, hash) => {
    expect(await verifyPassword(hash, "correct horse battery")).toBe(false);
  });
});
