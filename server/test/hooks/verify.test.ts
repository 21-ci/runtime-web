import { describe, expect, it, vi } from "vitest";
import { hex, hmacSha256, sha256 } from "../../src/crypto/hash.ts";
import * as hash from "../../src/crypto/hash.ts";
import { signOutbound, verifyWebhook, type WebhookProvider } from "../../src/hooks/verify.ts";

const SECRET = "dev-insecure-webhook-secret";
const body = new TextEncoder().encode('{"ref":"refs/heads/main"}');
const hmacHex = async (s: string, b: Uint8Array) => hex(await hmacSha256(s, b));
const h = (o: Record<string, string>) => new Headers(o);

function flip(sig: string): string {
  const last = sig.at(-1) === "0" ? "1" : "0";
  return sig.slice(0, -1) + last;
}

const signed = async (p: WebhookProvider, s = SECRET, b = body): Promise<Headers> => {
  if (p === "github") return h({ "x-hub-signature-256": `sha256=${await hmacHex(s, b)}` });
  if (p === "gitea") return h({ "x-gitea-signature": await hmacHex(s, b) });
  return h({ "x-gitlab-token": s });
};

describe.each(["github", "gitea", "gitlab"] as const)("verifyWebhook %s", (p) => {
  it("accepts a correct delivery", async () => {
    expect(await verifyWebhook(p, await signed(p), body, SECRET)).toBe(true);
  });

  it("rejects a missing header", async () => {
    expect(await verifyWebhook(p, h({}), body, SECRET)).toBe(false);
  });

  it("rejects the wrong secret", async () => {
    expect(await verifyWebhook(p, await signed(p, "other-secret"), body, SECRET)).toBe(false);
  });

  it("fails closed on an empty secret", async () => {
    expect(await verifyWebhook(p, await signed(p), body, "")).toBe(false);
  });

  it("rejects an empty header", async () => {
    const name = [...(await signed(p)).keys()][0] ?? "";
    expect(await verifyWebhook(p, h({ [name]: "" }), body, SECRET)).toBe(false);
  });

  it("rejects repeated headers, which arrive joined", async () => {
    const good = await signed(p);
    const [name, value] = [...good.entries()][0] ?? ["", ""];
    const twice = new Headers();
    twice.append(name, value);
    twice.append(name, value);
    expect(await verifyWebhook(p, twice, body, SECRET)).toBe(false);
  });
});

describe.each(["github", "gitea"] as const)("verifyWebhook %s signature", (p) => {
  it("rejects a tampered body", async () => {
    const other = new TextEncoder().encode('{"ref":"refs/heads/evil"}');
    expect(await verifyWebhook(p, await signed(p), other, SECRET)).toBe(false);
  });

  it("verifies the raw bytes: a re-serialized body of equal meaning fails", async () => {
    const raw = new TextEncoder().encode('{ "a": 1 }');
    const reparsed = new TextEncoder().encode(JSON.stringify(JSON.parse('{ "a": 1 }')));
    expect(await verifyWebhook(p, await signed(p, SECRET, raw), raw, SECRET)).toBe(true);
    expect(await verifyWebhook(p, await signed(p, SECRET, raw), reparsed, SECRET)).toBe(false);
  });
});

describe("hostile signature forms", () => {
  it("github: tampered digit, wrong prefix, bare hex, short, non-hex, uppercase", async () => {
    const mac = await hmacHex(SECRET, body);
    for (const v of [
      `sha256=${flip(mac)}`,
      `sha1=${mac}`,
      mac,
      `sha256=${mac.slice(0, 32)}`,
      `sha256=${"z".repeat(64)}`,
      `sha256=${mac.toUpperCase()}`,
      `sha256=${mac}00`,
    ]) {
      expect(await verifyWebhook("github", h({ "x-hub-signature-256": v }), body, SECRET), v).toBe(false);
    }
  });

  it("gitea: tampered digit, prefixed, short", async () => {
    const mac = await hmacHex(SECRET, body);
    for (const v of [flip(mac), `sha256=${mac}`, mac.slice(0, 10)]) {
      expect(await verifyWebhook("gitea", h({ "x-gitea-signature": v }), body, SECRET), v).toBe(false);
    }
  });

  it("gitlab: a near-match token fails", async () => {
    expect(await verifyWebhook("gitlab", h({ "x-gitlab-token": flip(SECRET) }), body, SECRET)).toBe(false);
  });

  it("does not take another provider's header", async () => {
    expect(await verifyWebhook("github", await signed("gitea"), body, SECRET)).toBe(false);
    expect(await verifyWebhook("gitlab", await signed("github"), body, SECRET)).toBe(false);
  });

  it("refuses an unknown provider", async () => {
    expect(await verifyWebhook("bitbucket" as WebhookProvider, await signed("github"), body, SECRET)).toBe(false);
  });
});

describe("constant-time comparison", () => {
  it("every provider compares through constantTimeEqual, GitLab over equal-length digests", async () => {
    const spy = vi.spyOn(hash, "constantTimeEqual");
    await verifyWebhook("gitlab", h({ "x-gitlab-token": "short" }), body, SECRET);
    const [a, b] = spy.mock.calls[0] ?? [];
    expect(a).toEqual(await sha256("short"));
    expect(b).toEqual(await sha256(SECRET));
    spy.mockClear();
    await verifyWebhook("github", await signed("github"), body, SECRET);
    await verifyWebhook("gitea", await signed("gitea"), body, SECRET);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe("no leaks", () => {
  it("logs nothing about the secret, the signature or the body", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    await verifyWebhook("github", h({ "x-hub-signature-256": "sha256=bad" }), body, SECRET);
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });
});

describe("signOutbound", () => {
  it("signs t.body with the timestamp in seconds", async () => {
    const at = 1_700_000_000_999;
    const v = await signOutbound(SECRET, body, at);
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(v);
    expect(m?.[1]).toBe("1700000000");
    const signedBytes = new Uint8Array([...new TextEncoder().encode("1700000000."), ...body]);
    expect(m?.[2]).toBe(await hmacHex(SECRET, signedBytes));
  });

  it("changes with the time and with the body", async () => {
    const a = await signOutbound(SECRET, body, 1_000_000);
    expect(await signOutbound(SECRET, body, 2_000_000)).not.toBe(a);
    expect(await signOutbound(SECRET, new Uint8Array([1]), 1_000_000)).not.toBe(a);
  });

  it("refuses to sign with an empty secret", async () => {
    await expect(signOutbound("", body, 1_000_000)).rejects.toThrow();
  });
});
