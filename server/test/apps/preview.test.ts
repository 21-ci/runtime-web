import { describe, expect, it } from "vitest";
import { AppError } from "../../src/http/errors.ts";
import { MAX_PREVIEW_BYTES, readPreview } from "../../src/apps/preview.ts";

const URL_ = "https://hello.apps.example.test/";

function stub(res: Response | Error) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (res instanceof Error) throw res;
    return res;
  }) as typeof fetch;
  return { f, calls };
}

describe("readPreview", () => {
  it("returns the status, type and text of one anonymous GET", async () => {
    const { f, calls } = stub(new Response('{"ok":true}', { status: 404, headers: { "content-type": "application/json" } }));
    expect(await readPreview(f, URL_)).toEqual({ status: 404, content_type: "application/json", body: '{"ok":true}', truncated: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(URL_);
    expect(calls[0]?.init?.method).toBe("GET");
    // A redirect from an app must not make the console fetch another host on its behalf.
    expect(calls[0]?.init?.redirect).toBe("manual");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("authorization")).toBe(false);
  });

  it("caps what it reads", async () => {
    const big = "x".repeat(MAX_PREVIEW_BYTES + 100);
    const { f } = stub(new Response(big, { headers: { "content-type": "text/plain" } }));
    const out = await readPreview(f, URL_);
    expect(out.truncated).toBe(true);
    expect(out.body?.length).toBe(MAX_PREVIEW_BYTES);
  });

  it("does not read a binary body", async () => {
    const { f } = stub(new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } }));
    expect(await readPreview(f, URL_)).toEqual({ status: 200, content_type: "image/png", body: null, truncated: false });
  });

  it("answers preview_unavailable when the app cannot be reached or has no absolute URL", async () => {
    const { f } = stub(new TypeError("egress denied"));
    await expect(readPreview(f, URL_)).rejects.toMatchObject({ code: "preview_unavailable", status: 502 });
    const none = stub(new Response("no"));
    await expect(readPreview(none.f, "/s/hello/")).rejects.toBeInstanceOf(AppError);
    expect(none.calls).toHaveLength(0);
  });
});
