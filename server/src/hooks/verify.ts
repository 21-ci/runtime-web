// Webhook signatures, checked over the raw body before any JSON parse. A valid signature only proves the
// sender knew the secret: GitHub signatures carry no timestamp, delivery ids are unsigned, and GitLab's
// token is a static bearer with no body integrity. So a verified webhook is a hint to go and look,
// never a statement of what to deploy. Every failure is a plain false, with nothing logged.

import { constantTimeEqual, hex, hmacSha256, sha256 } from "../crypto/hash.ts";

export type WebhookProvider = "github" | "gitea" | "gitlab";

const GITHUB_SIG = /^sha256=([0-9a-f]{64})$/;
const GITEA_SIG = /^([0-9a-f]{64})$/;

async function hmacMatches(header: string | null, form: RegExp, body: Uint8Array, secret: string): Promise<boolean> {
  const given = header === null ? null : form.exec(header)?.[1];
  if (!given) return false;
  return constantTimeEqual(given, hex(await hmacSha256(secret, body)));
}

export async function verifyWebhook(provider: WebhookProvider, headers: Headers, rawBody: Uint8Array, secret: string): Promise<boolean> {
  if (secret === "") return false;
  switch (provider) {
    case "github":
      return hmacMatches(headers.get("x-hub-signature-256"), GITHUB_SIG, rawBody, secret);
    case "gitea":
      return hmacMatches(headers.get("x-gitea-signature"), GITEA_SIG, rawBody, secret);
    case "gitlab": {
      const token = headers.get("x-gitlab-token");
      if (!token) return false;
      // Digests, so that the comparison neither depends on nor reveals the token's length.
      return constantTimeEqual(await sha256(token), await sha256(secret));
    }
    default:
      return false;
  }
}

/** Value of X-Rtweb-Signature for an outbound webhook: `t=<unix>,v1=<hmac(t.body)>`. */
export async function signOutbound(secret: string, body: Uint8Array, nowMs: number): Promise<string> {
  if (secret === "") throw new Error("hooks: empty signing secret");
  const t = Math.floor(nowMs / 1000);
  const prefix = new TextEncoder().encode(`${t}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  return `t=${t},v1=${hex(await hmacSha256(secret, signed))}`;
}
