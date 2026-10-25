import { AppError, badRequest, errorBody } from "./errors.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(JSON_HEADERS);
  if (headers) new Headers(headers).forEach((v, k) => h.set(k, v));
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function noContent(headers?: HeadersInit): Response {
  return new Response(null, { status: 204, ...(headers ? { headers } : {}) });
}

/** Error envelope; 429/503 with details.retry_after also set Retry-After. */
export function errorResponse(err: AppError): Response {
  const res = json(errorBody(err), err.status);
  const ra = err.details?.retry_after;
  if ((err.status === 429 || err.status === 503) && typeof ra === "number") res.headers.set("retry-after", String(ra));
  return res;
}

const MAX_JSON_BYTES = 1 << 20;

/** Reads a JSON object body; 400 on non-JSON, wrong content type or oversize. */
export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("application/json")) {
    throw badRequest("bad_request", "expected application/json");
  }
  const tooLarge = () => new AppError(413, "too_large", "body too large");
  if (Number(req.headers.get("content-length") ?? 0) > MAX_JSON_BYTES) throw tooLarge();
  // The cap is in bytes: text.length counts UTF-16 units, so multi-byte bodies could reach ~3x the cap.
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_JSON_BYTES) throw tooLarge();
  const text = new TextDecoder().decode(bytes);
  try {
    const v: unknown = JSON.parse(text);
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as T;
  } catch {
    throw badRequest("bad_request", "malformed JSON body");
  }
}
