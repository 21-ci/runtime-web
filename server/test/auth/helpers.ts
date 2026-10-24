import { expect } from "vitest";
import { totp, base32Decode } from "../../src/crypto/totp.ts";
import { testApp, TEST_ORIGIN, TEST_SETUP_TOKEN, type TestApp } from "../harness.ts";
import type { Deps } from "../../src/app.ts";
import { ensureMigrated } from "../../src/db/migrate.ts";

export const PW = "correct horse battery";
export const ADMIN = { email: "admin@example.com", name: "Admin", password: PW };

/** A signed-in client: carries the cookie and CSRF token. */
export interface Client {
  cookie: string;
  csrf: string;
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
}

export function cookieOf(res: Response): string {
  const sc = res.headers.getSetCookie().find((c) => c.includes("rtw_session="));
  expect(sc, "session cookie").toBeDefined();
  return (sc as string).split(";")[0] as string;
}

export function client(app: TestApp, cookie: string, csrf: string): Client {
  return {
    cookie,
    csrf,
    call: (method, path, body, headers = {}) =>
      app.call(method, path, {
        ...(body !== undefined ? { body } : {}),
        headers: { origin: TEST_ORIGIN, cookie, "x-csrf-token": csrf, ...headers },
      }),
  };
}

/** POST with only Origin (public routes). */
export const post = (app: TestApp, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.call("POST", path, { body, headers: { origin: TEST_ORIGIN, ...headers } });

export async function setupAdmin(app: TestApp): Promise<Client> {
  const res = await post(app, "/api/setup", { setup_token: TEST_SETUP_TOKEN, ...ADMIN });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { csrf: string };
  return client(app, cookieOf(res), body.csrf);
}

/** Inserts a user row directly (password hashed with the app's hasher). */
export async function addUser(
  app: TestApp,
  email: string,
  opts: { admin?: boolean; disabled?: boolean; mustChange?: boolean; password?: string } = {},
): Promise<string> {
  await ensureMigrated(app.deps.storage.db);
  const id = `usr_${email.replace(/\W/g, "")}`;
  const hash = await (app.deps.hasher as NonNullable<Deps["hasher"]>).hash(opts.password ?? PW);
  await app.deps.storage.db.run(
    "INSERT INTO users (id, email, name, pw_hash, must_change, instance_admin, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, email, email.split("@")[0] as string, hash, opts.mustChange ? 1 : 0, opts.admin ? 1 : 0, opts.disabled ? 1 : 0, app.deps.now(), app.deps.now()],
  );
  return id;
}

export async function loginAs(app: TestApp, email: string, password = PW, headers: Record<string, string> = {}): Promise<Response> {
  return post(app, "/api/auth/login", { email, password }, headers);
}

export async function signIn(app: TestApp, email: string, password = PW): Promise<Client> {
  const res = await loginAs(app, email, password);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { csrf: string; mfa_required: boolean };
  expect(body.mfa_required).toBe(false);
  return client(app, cookieOf(res), body.csrf);
}

/** Current TOTP code for the secret inside an otpauth URL. */
export async function codeFor(app: TestApp, otpauth: string, offsetSteps = 0): Promise<string> {
  const secret = base32Decode(new URL(otpauth).searchParams.get("secret") as string);
  return totp(secret, app.deps.now() + offsetSteps * 30_000);
}

/** Enrolls and confirms TOTP for c; returns the otpauth URL and recovery codes. */
export async function enableTotp(app: TestApp, c: Client): Promise<{ url: string; codes: string[] }> {
  const e = await c.call("POST", "/api/me/totp/enroll", { password: PW });
  expect(e.status).toBe(200);
  const url = ((await e.json()) as { otpauth_url: string }).otpauth_url;
  const res = await c.call("POST", "/api/me/totp/confirm", { code: await codeFor(app, url) });
  expect(res.status).toBe(200);
  const codes = ((await res.json()) as { recovery_codes: string[] }).recovery_codes;
  app.tick(30_000); // next code is a fresh step
  return { url, codes };
}

export async function errCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

export { testApp, TEST_ORIGIN, TEST_SETUP_TOKEN };
