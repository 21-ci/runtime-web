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

export function errorResponse(err: AppError): Response {
  return json(errorBody(err), err.status);
}

const MAX_JSON_BYTES = 1 << 20;

/** Reads a JSON object body; 400 on non-JSON, wrong content type or oversize. */
export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("application/json")) {
    throw badRequest("bad_request", "expected application/json");
  }
  const text = await req.text();
  if (text.length > MAX_JSON_BYTES) throw new AppError(413, "too_large", "body too large");
  try {
    const v: unknown = JSON.parse(text);
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as T;
  } catch {
    throw badRequest("bad_request", "malformed JSON body");
  }
}
