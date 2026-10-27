// Smoke journey (plus the 2FA, invite and custom-domain checks). Runs against a runtime-hosted console:
// RTWEB_URL (console) and RTWEB_APPS_URL (the runtime invoke listener that serves apps at
// /s/{slug}/ and custom hosts). See Makefile target `e2e`.
import { createHmac } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const CONSOLE = process.env.RTWEB_URL ?? "";
const RUNTIME = process.env.RTWEB_APPS_URL ?? process.env.RTWEB_RUNTIME_PUBLIC_URL ?? new URL(CONSOLE || "http://invalid").origin;
const SETUP_TOKEN = process.env.RTWEB_SETUP_TOKEN ?? "dev-insecure-setup";

const ORG = "smoke-org";
const PROJECT = "web";
const APP = "smoke-app";
const ADMIN = { email: "admin@smoke.test", name: "Smoke Admin", password: "smoke-admin-passphrase-1" };
const OWNER = { email: "owner@smoke.test", name: "Smoke Owner", password: "smoke-owner-passphrase-2" };
const INVITEE = { email: "invitee@smoke.test", name: "Smoke Invitee", password: "smoke-invitee-passphrase-3" };
const CUSTOM_HOST = "docs.custom.test";

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s), so the spec needs no TOTP dependency.
function totp(secretB32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secretB32.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

// Waits for the next 30 s TOTP step so a code that was already used can be replaced.
async function nextStep(page: Page) {
  await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
}

// JSON call to the console API from the browser context (shares its cookies). Unsafe methods need
// the Origin header and, with a session, the CSRF token.
async function api(
  ctx: BrowserContext | Page,
  method: string,
  path: string,
  opts: { data?: unknown; csrf?: string; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { Origin: CONSOLE, ...(opts.headers ?? {}) };
  if (opts.csrf) headers["X-CSRF-Token"] = opts.csrf;
  return ctx.request.fetch(CONSOLE + path, { method, data: opts.data, headers, maxRedirects: 0 });
}

test("smoke: setup, org, 2FA, app, invite, custom domain", async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();

  await test.step("setup page: wrong token refused, then admin created", async () => {
    expect(await (await api(admin, "GET", "/api/setup")).json()).toEqual({ needed: true });
    const bad = await api(admin, "POST", "/api/setup", {
      data: { setup_token: "wrong-token", ...ADMIN },
    });
    expect(bad.status()).toBe(403);

    await admin.goto("/setup");
    await admin.fill('input[name="setup_token"]', SETUP_TOKEN);
    await admin.fill('input[name="email"]', ADMIN.email);
    await admin.fill('input[name="name"]', ADMIN.name);
    await admin.fill('input[name="password"]', ADMIN.password);
    await admin.getByRole("button", { name: "Create admin" }).click();
    await expect(admin).not.toHaveURL(/\/setup/);
  });

  const adminCsrf = (await (await api(admin, "GET", "/api/me")).json()).csrf as string;
  const adminId = (await (await api(admin, "GET", "/api/me")).json()).user.id as string;

  // Admin creates the owner (temporary password) and an org that the owner holds.
  const created = await api(admin, "POST", "/api/admin/users", {
    csrf: adminCsrf,
    data: { email: OWNER.email, name: OWNER.name },
  });
  expect(created.status()).toBe(201);
  const { user: owner, temp_password: tempPassword } = await created.json();
  const org = await api(admin, "POST", "/api/admin/orgs", {
    csrf: adminCsrf,
    data: { slug: ORG, name: "Smoke Org", owner_user_id: owner.id },
  });
  expect(org.status()).toBe(201);
  expect(adminId).toBeTruthy();

  // Owner signs in through the UI, sets a password (first login), enrolls TOTP and signs out.
  const ownerCtx = await browser.newContext();
  const ownerPage = await ownerCtx.newPage();
  let ownerCsrf = "";
  let totpSecret = "";

  await test.step("owner: login, change password, enroll and confirm TOTP", async () => {
    await ownerPage.goto("/login");
    await ownerPage.fill('input[name="email"]', OWNER.email);
    await ownerPage.fill('input[name="password"]', tempPassword);
    await ownerPage.getByRole("button", { name: "Sign in" }).click();
    await expect(ownerPage).toHaveURL(/\/change-password/);

    const changed = await api(ownerPage, "PUT", "/api/me/password", {
      data: { current_password: tempPassword, new_password: OWNER.password },
    });
    expect(changed.status()).toBe(204);

    ownerCsrf = (await (await api(ownerPage, "GET", "/api/me")).json()).csrf as string;
    const enroll = await api(ownerPage, "POST", "/api/me/totp/enroll", { csrf: ownerCsrf });
    expect(enroll.status()).toBe(200);
    const otpauth = new URL((await enroll.json()).otpauth_url as string);
    totpSecret = otpauth.searchParams.get("secret") ?? "";
    expect(totpSecret).not.toBe("");

    const confirm = await api(ownerPage, "POST", "/api/me/totp/confirm", {
      csrf: ownerCsrf,
      data: { code: totp(totpSecret) },
    });
    expect(confirm.status()).toBe(200);
    expect((await confirm.json()).recovery_codes).toHaveLength(10);

    const out = await api(ownerPage, "POST", "/api/auth/logout", { csrf: ownerCsrf });
    expect(out.status()).toBe(204);
  });

  await test.step("owner: TOTP login; a used code is rejected", async () => {
    await ownerPage.goto("/login");
    await ownerPage.fill('input[name="email"]', OWNER.email);
    await ownerPage.fill('input[name="password"]', OWNER.password);
    await ownerPage.getByRole("button", { name: "Sign in" }).click();
    await expect(ownerPage).toHaveURL(/\/login\/mfa/);

    // The code used at confirm is still in its window: replay must fail.
    await ownerPage.fill('input[name="code"]', totp(totpSecret));
    await ownerPage.getByRole("button", { name: /verify|continue|sign in/i }).click();
    await expect(ownerPage).toHaveURL(/\/login\/mfa/);

    await nextStep(ownerPage);
    await ownerPage.fill('input[name="code"]', totp(totpSecret));
    await ownerPage.getByRole("button", { name: /verify|continue|sign in/i }).click();
    await expect(ownerPage).not.toHaveURL(/\/login/);
    ownerCsrf = (await (await api(ownerPage, "GET", "/api/me")).json()).csrf as string;
  });

  const project = await api(ownerPage, "POST", `/api/orgs/${ORG}/projects`, {
    csrf: ownerCsrf,
    data: { slug: PROJECT },
  });
  expect(project.status()).toBe(201);

  await test.step("owner: create app from the HTTP template; runtime serves it within 15 s", async () => {
    await ownerPage.goto(`/${ORG}/apps/new`);
    await ownerPage.getByLabel("Project").click();
    await ownerPage.getByRole("option", { name: new RegExp(PROJECT) }).click();
    await ownerPage.getByLabel("Environment").click();
    await ownerPage.getByRole("option").first().click();
    await ownerPage.fill('input[name="slug"]', APP);
    await ownerPage.getByRole("button", { name: "Create app" }).click();
    await expect(ownerPage).toHaveURL(new RegExp(`/${ORG}/apps/${APP}`));

    await expect
      .poll(async () => (await ownerPage.request.get(`${RUNTIME}/s/${APP}/`)).status(), {
        timeout: 15_000,
        intervals: [500],
      })
      .toBe(200);
  });

  await test.step("owner: save edited code (PUT files); the new version is served", async () => {
    const appRes = await api(ownerPage, "GET", `/api/orgs/${ORG}/apps/${APP}`);
    expect(appRes.status()).toBe(200);
    const etag = appRes.headers()["etag"];
    expect(etag).toBeTruthy();
    const cur = await (await api(ownerPage, "GET", `/api/orgs/${ORG}/apps/${APP}/files`)).json();
    const marker = `smoke-saved-${Date.now()}`;
    const files: Record<string, string> = { ...cur.files };
    files[cur.entry] = `export default { fetch() { return new Response(${JSON.stringify(marker)}); } };\n`;
    const saved = await api(ownerPage, "PUT", `/api/orgs/${ORG}/apps/${APP}/files`, {
      csrf: ownerCsrf,
      headers: { "If-Match": etag },
      data: { entry: cur.entry, files },
    });
    expect(saved.status()).toBe(200);
    expect((await saved.json()).version.version).toBeGreaterThan(1);
    await expect
      .poll(async () => (await ownerPage.request.get(`${RUNTIME}/s/${APP}/`)).text(), {
        timeout: 15_000,
        intervals: [500],
      })
      .toContain(marker);
  });

  await test.step("owner invites a member; invitee accepts and signs in", async () => {
    const ownerCsrfNow = (await (await api(ownerPage, "GET", "/api/me")).json()).csrf as string;
    const inv = await api(ownerPage, "POST", `/api/orgs/${ORG}/invites`, {
      csrf: ownerCsrfNow,
      data: { email: INVITEE.email, role: "member" },
    });
    expect(inv.status()).toBe(201);
    const token = String((await inv.json()).link).split("/").pop() ?? "";

    const inviteeCtx = await browser.newContext();
    const invitee = await inviteeCtx.newPage();
    await invitee.goto(`/invite/${token}`);
    await invitee.fill('input[name="name"]', INVITEE.name);
    await invitee.fill('input[name="password"]', INVITEE.password);
    await invitee.locator('button[type="submit"]').click();
    await expect
      .poll(async () => (await (await api(invitee, "GET", "/api/me")).json()).user?.email)
      .toBe(INVITEE.email);
    await inviteeCtx.close();
  });

  await test.step("custom domain: unverified host gets no route on the runtime", async () => {
    const dom = await api(ownerPage, "POST", `/api/orgs/${ORG}/apps/${APP}/domains`, {
      csrf: ownerCsrf,
      data: { host: CUSTOM_HOST },
    });
    expect(dom.status()).toBe(201);
    const { id, txt_name: txtName, txt_value: txtValue } = await dom.json();
    expect(txtName).toBe(`_rtweb.${CUSTOM_HOST}`);
    expect(txtValue).toMatch(/^[0-9a-f]{32}$/);

    // No TXT record yet, so verify must keep the domain pending.
    const verify = await api(ownerPage, "POST", `/api/orgs/${ORG}/apps/${APP}/domains/${id}/verify`, {
      csrf: ownerCsrf,
    });
    expect((await verify.json()).status).toBe("pending");

    // Host header injection: the runtime must not route an unverified custom host.
    const unverified = await ownerPage.request.get(`${RUNTIME}/`, { headers: { Host: CUSTOM_HOST } });
    expect(unverified.status()).toBe(404);

    // The verified path (TXT published, host mapped on the runtime) needs real DNS; it is covered
    // by server/test/domains with a fake resolver.
  });

  await adminCtx.close();
  await ownerCtx.close();
});
