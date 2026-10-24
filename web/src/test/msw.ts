import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

// Handlers are written by hand from docs/reference/api.md. Tests override per case with server.use(...).
export const handlers = [
  http.get("/api/auth/providers", () =>
    HttpResponse.json({ password_login_disabled: false, providers: [] }),
  ),
  http.get("/api/setup", () => HttpResponse.json({ needed: false })),
  http.get("/api/me", () => HttpResponse.json({ error: { code: "unauthenticated", message: "signed out" } }, { status: 401 })),
];

export const server = setupServer(...handlers);

export const testUser = {
  id: "usr_1",
  email: "ada@example.test",
  name: "Ada",
  instance_admin: false,
  must_change_password: false,
  disabled: false,
  totp_enabled: false,
  created_at: 1_700_000_000_000,
};

export function apiError(status: number, code: string, message = code, extra?: Record<string, unknown>) {
  return HttpResponse.json({ error: { code, message, ...extra } }, { status });
}
