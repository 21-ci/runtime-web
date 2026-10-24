// argon2id password hashing (port of internal/auth/password.go). Same params as
// Go (m=64 MiB, t=3, p=2, 16-byte salt, 32-byte key), PHC string output, so hashes
// written by either implementation verify in the other.

import { argon2id } from "hash-wasm";
import { constantTimeEqual } from "./hash.ts";
import { randomBytes } from "./random.ts";

export const ARGON2_PARAMS = { memoryKiB: 64 * 1024, iterations: 3, parallelism: 2, saltBytes: 16, keyBytes: 32 } as const;

// Limits from Go Verify: refuse parameters that could exhaust memory on a corrupt row.
const MAX_MEMORY_KIB = 1 << 20;
const MAX_ITERATIONS = 16;
const MAX_KEY_BYTES = 128;

const B64RAW = /^[A-Za-z0-9+/]+$/;

/** Returns the PHC string for password, with a fresh random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(ARGON2_PARAMS.saltBytes);
  const key = await argon2id({
    password,
    salt,
    memorySize: ARGON2_PARAMS.memoryKiB,
    iterations: ARGON2_PARAMS.iterations,
    parallelism: ARGON2_PARAMS.parallelism,
    hashLength: ARGON2_PARAMS.keyBytes,
    outputType: "binary",
  });
  const { memoryKiB, iterations, parallelism } = ARGON2_PARAMS;
  return `$argon2id$v=19$m=${memoryKiB},t=${iterations},p=${parallelism}$${b64raw(salt)}$${b64raw(key)}`;
}

/**
 * Verifies password against a PHC argon2id string. Malformed or out-of-range
 * hashes return false (never throw). The comparison is constant time.
 */
export async function verifyPassword(phc: string, password: string): Promise<boolean> {
  const p = parsePhc(phc);
  if (!p) return false;
  const got = await argon2id({
    password,
    salt: p.salt,
    memorySize: p.memoryKiB,
    iterations: p.iterations,
    parallelism: p.parallelism,
    hashLength: p.key.length,
    outputType: "binary",
  });
  return constantTimeEqual(got, p.key);
}

interface Phc {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  salt: Uint8Array;
  key: Uint8Array;
}

/** Parses and bounds-checks a `$argon2id$v=19$m=..,t=..,p=..$salt$key` string. */
export function parsePhc(phc: string): Phc | null {
  const parts = phc.split("$");
  if (parts.length !== 6 || parts[0] !== "" || parts[1] !== "argon2id") return null;
  if (parts[2] !== "v=19") return null;
  const m = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(parts[3] ?? "");
  if (!m) return null;
  const memoryKiB = Number(m[1]);
  const iterations = Number(m[2]);
  const parallelism = Number(m[3]);
  if (memoryKiB < 1 || memoryKiB > MAX_MEMORY_KIB) return null;
  if (iterations < 1 || iterations > MAX_ITERATIONS) return null;
  if (parallelism < 1 || parallelism > 255) return null;
  const salt = unb64raw(parts[4] ?? "");
  const key = unb64raw(parts[5] ?? "");
  if (!salt || salt.length === 0) return null;
  if (!key || key.length === 0 || key.length > MAX_KEY_BYTES) return null;
  return { memoryKiB, iterations, parallelism, salt, key };
}

function b64raw(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "");
}

function unb64raw(s: string): Uint8Array | null {
  if (!B64RAW.test(s) || s.length % 4 === 1) return null;
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
