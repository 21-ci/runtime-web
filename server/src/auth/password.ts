// Password policy and the injectable hasher.
// The argon2id implementation lives in crypto/password.ts; tests inject a cheap
// hasher through Deps.hasher so suites stay fast.

import { hashPassword, needsRehash, verifyPassword } from "../crypto/password.ts";

/** Minimum password length in code points (Go MinPasswordLength). */
export const MIN_PASSWORD_LENGTH = 12;
/** Upper bound so a huge body cannot burn the CPU budget in argon2. */
export const MAX_PASSWORD_LENGTH = 1024;

export interface Hasher {
  hash(password: string): Promise<string>;
  /** Never throws: malformed hashes are false. */
  verify(phc: string, password: string): Promise<boolean>;
  /** True when phc uses older parameters and should be replaced after a successful verify. */
  needsRehash?(phc: string): boolean;
}

export const argon2Hasher: Hasher = { hash: hashPassword, verify: verifyPassword, needsRehash };

/** Field error code for a password, or null when it passes the policy. */
export function passwordProblem(p: unknown): string | null {
  if (typeof p !== "string" || p.length === 0) return "required";
  const n = [...p].length;
  if (n < MIN_PASSWORD_LENGTH) return "too_short";
  if (n > MAX_PASSWORD_LENGTH) return "too_long";
  return null;
}
