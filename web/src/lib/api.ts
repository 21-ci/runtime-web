import { setRuntimeStatus } from "./runtime-status";

// ApiError is the web API error envelope {error:{code,message,details?}} plus transport metadata.
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly retryAfter?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }

  // fieldErrors returns the web validation map from a 422 invalid body, keyed by request field path.
  fieldErrors(): Record<string, string> {
    const fields = this.details?.fields;
    if (!fields || typeof fields !== "object") return {};
    return Object.fromEntries(
      Object.entries(fields as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }
}

type Navigator = (to: string) => void;

let navigator_: Navigator = (to) => {
  window.location.assign(to);
};
let csrf: string | null = null;

// setNavigator wires redirects (401, gates) to the router. Tests and main.tsx call it.
export function setNavigator(fn: Navigator) {
  navigator_ = fn;
}

export function setCsrfToken(token: string | null) {
  csrf = token;
}

export function getCsrfToken(): string | null {
  return csrf;
}

// skipGate: the call must not redirect on 401 or gate errors (used by the session bootstrap).
export type RequestOptions = { ifMatch?: string; skipGate?: boolean };

const PUBLIC_PREFIXES = ["/login", "/setup", "/invite/"];

function currentPath(): string {
  return window.location.pathname + window.location.search;
}

function onGate(code: string) {
  const here = window.location.pathname;
  if (code === "unauthenticated" && !PUBLIC_PREFIXES.some((p) => here.startsWith(p))) {
    navigator_(`/login?next=${encodeURIComponent(currentPath())}`);
  } else if (code === "password_change_required" && here !== "/change-password") {
    navigator_("/change-password");
  } else if (code === "mfa_enrollment_required" && here !== "/me/security") {
    navigator_("/me/security");
  }
}

async function parseError(res: Response): Promise<ApiError> {
  const retryHeader = res.headers.get("Retry-After");
  let code = "internal";
  let message = res.statusText || "Request failed";
  let details: Record<string, unknown> | undefined;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
    details = body.error?.details;
  } catch {
    // Non-JSON error body (proxy page, empty 5xx): keep the generic values.
  }
  const headerSeconds = retryHeader ? Number.parseInt(retryHeader, 10) : Number.NaN;
  const bodySeconds = typeof details?.retry_after === "number" ? details.retry_after : Number.NaN;
  const retryAfter = Number.isFinite(headerSeconds) ? headerSeconds : bodySeconds;
  return new ApiError(res.status, code, message, details, Number.isFinite(retryAfter) ? retryAfter : undefined);
}

async function request<T>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
  if (method !== "GET" && method !== "HEAD" && csrf) headers["X-CSRF-Token"] = csrf;
  if (opts?.ifMatch) headers["If-Match"] = opts.ifMatch;

  let res: Response;
  try {
    res = await fetch(`${window.location.origin}/api${path}`, {
      method,
      headers,
      credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    setRuntimeStatus(null);
    throw new ApiError(0, "network", "Network error. Check your connection.");
  }

  if (!res.ok) {
    const err = await parseError(res);
    if (err.status === 503 && err.code === "busy") setRuntimeStatus("busy");
    if (err.status === 502 && err.code === "runtime_unavailable") setRuntimeStatus("unavailable");
    if (err.status === 401) csrf = null;
    if (!opts?.skipGate) onGate(err.code);
    throw err;
  }

  setRuntimeStatus(null);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>("GET", path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("POST", path, body ?? {}, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("PUT", path, body ?? {}, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("PATCH", path, body ?? {}, opts),
  del: <T>(path: string, opts?: RequestOptions) => request<T>("DELETE", path, undefined, opts),
};
