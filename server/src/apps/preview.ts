// The console's response preview. A browser cannot read a cross-origin app response, and a framed one can be neither
// themed nor pretty-printed, so an explicit click asks this route to make one anonymous GET and hand the text back.
// The console renders the body as text only; it never becomes markup on the console's origin.

import { AppError } from "../http/errors.ts";
import { BudgetExhausted } from "../jobs/budget.ts";

export const MAX_PREVIEW_BYTES = 256 * 1024;
const TIMEOUT_MS = 5_000;
const TEXTUAL = /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript)\b)/i;

export interface PreviewResponse {
  status: number | null;
  content_type: string | null;
  /** The text of the response; null when it is binary. */
  body: string | null;
  truncated: boolean;
  /** The app refuses anonymous calls, so nothing was asked. */
  needs_key?: true;
}

/** No request: the anonymous call this route makes could only be refused. */
export const NEEDS_KEY: PreviewResponse = { status: null, content_type: null, body: null, truncated: false, needs_key: true };

const unavailable = () => new AppError(502, "preview_unavailable", "the console cannot reach this app; open it directly");

async function readHead(stream: ReadableStream<Uint8Array>): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = stream.getReader();
  const out = new Uint8Array(MAX_PREVIEW_BYTES);
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bytes: out.subarray(0, at), truncated: false };
    const room = MAX_PREVIEW_BYTES - at;
    out.set(value.subarray(0, room), at);
    at += Math.min(room, value.length);
    if (value.length > room) {
      await reader.cancel().catch(() => undefined);
      return { bytes: out.subarray(0, at), truncated: true };
    }
  }
}

export async function readPreview(f: typeof fetch, url: string): Promise<PreviewResponse> {
  if (!/^https?:\/\//.test(url)) throw unavailable();
  try {
    // Sends no console credentials. Manual redirects keep the request on the app's own host.
    const res = await f(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json, text/*;q=0.9, */*;q=0.1" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const type = res.headers.get("content-type");
    if ((type !== null && !TEXTUAL.test(type)) || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, content_type: type, body: null, truncated: false };
    }
    const { bytes, truncated } = await readHead(res.body);
    return { status: res.status, content_type: type, body: new TextDecoder().decode(bytes), truncated };
  } catch (e) {
    if (e instanceof BudgetExhausted) throw e;
    throw unavailable();
  }
}
