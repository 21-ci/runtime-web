import { describe, expect, it } from "vitest";
import { readJson } from "../../src/http/json.ts";

const req = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://x/", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

describe("readJson", () => {
  it("parses an object body", async () => {
    await expect(readJson(req('{"a":1}'))).resolves.toEqual({ a: 1 });
  });

  it("caps the body in bytes, not UTF-16 units", async () => {
    // 400k three-byte chars: 1.2 MB of UTF-8 but only 400k string units.
    const body = JSON.stringify({ s: "€".repeat(400_000) });
    await expect(readJson(req(body))).rejects.toMatchObject({ status: 413 });
  });

  it("rejects an oversize content-length before reading", async () => {
    await expect(readJson(req("{}", { "content-length": String(2 << 20) }))).rejects.toMatchObject({ status: 413 });
  });
});
