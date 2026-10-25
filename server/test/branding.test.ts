import { describe, expect, it } from "vitest";
import { addUser, errCode, signIn } from "./auth/helpers.ts";
import { testApp, TEST_ORIGIN } from "./harness.ts";
import { ensureMigrated } from "../src/db/migrate.ts";
import { contrast, deriveAccent, mix } from "../src/branding/color.ts";
import { sniff, unsafeSvg } from "../src/branding/assets.ts";
import { themeCss, DEFAULTS } from "../src/branding/service.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const svg = (s: string) => new TextEncoder().encode(s);

async function setup() {
  const app = testApp();
  await ensureMigrated(app.deps.storage.db);
  await addUser(app, "root@x.test", { admin: true });
  await addUser(app, "plain@x.test");
  return { app, admin: await signIn(app, "root@x.test"), plain: await signIn(app, "plain@x.test") };
}

async function etagOf(app: Awaited<ReturnType<typeof setup>>["app"]) {
  const res = await app.call("GET", "/api/branding");
  return ((await res.json()) as { etag: string }).etag;
}

describe("GET /api/branding", () => {
  it("is public and returns the defaults with an ETag", async () => {
    const { app } = await setup();
    const res = await app.call("GET", "/api/branding");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ product_name: "", accent: "", palette: null, logo_light_url: null, icon_url: null, hide_powered_by: false, radius: "default", tint: "neutral" });
    expect(res.headers.get("etag")).toBe(`"${String(body.etag)}"`);
  });

  it("serves an empty theme.css by default and honours If-None-Match", async () => {
    const { app } = await setup();
    const res = await app.call("GET", "/api/branding/theme.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(await res.text()).not.toContain("--accent");
    const again = await app.call("GET", "/api/branding/theme.css", { headers: { "if-none-match": res.headers.get("etag") ?? "" } });
    expect(again.status).toBe(304);
  });

  it("404s an unknown or unset asset", async () => {
    const { app } = await setup();
    expect((await app.call("GET", "/api/branding/assets/logo-light")).status).toBe(404);
    expect((await app.call("GET", "/api/branding/assets/nope")).status).toBe(404);
  });
});

describe("PUT /api/admin/branding", () => {
  it("is instance-admin only and needs CSRF", async () => {
    const { app, plain, admin } = await setup();
    const etag = await etagOf(app);
    expect((await plain.call("PUT", "/api/admin/branding", { product_name: "X" }, { "if-match": etag })).status).toBe(403);
    expect((await app.call("PUT", "/api/admin/branding", { body: { product_name: "X" }, headers: { origin: TEST_ORIGIN, "if-match": etag } })).status).toBe(401);
    const noCsrf = await app.call("PUT", "/api/admin/branding", { body: { product_name: "X" }, headers: { origin: TEST_ORIGIN, cookie: admin.cookie, "if-match": etag } });
    expect(await errCode(noCsrf)).toBe("csrf_invalid");
  });

  it("requires If-Match and rejects a stale one", async () => {
    const { admin } = await setup();
    const missing = await admin.call("PUT", "/api/admin/branding", { product_name: "X" });
    expect(missing.status).toBe(428);
    const stale = await admin.call("PUT", "/api/admin/branding", { product_name: "X" }, { "if-match": '"old"' });
    expect(stale.status).toBe(409);
    expect(await errCode(stale)).toBe("stale");
  });

  it("stores fields, derives the palette, audits and changes the etag", async () => {
    const { app, admin } = await setup();
    const etag = await etagOf(app);
    const res = await admin.call(
      "PUT",
      "/api/admin/branding",
      { product_name: "Acme Cloud", accent: "#7C3AED", support_url: "https://help.acme.test", support_email: "help@acme.test", hide_powered_by: true, radius: "round", tint: "cool", login_headline: "Welcome", login_subtitle: "Sign in" },
      { "if-match": `"${etag}"` },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { etag: string; accent: string; palette: { light: { accent: string; on_accent: string }; dark: { accent: string } } };
    expect(body).toMatchObject({ product_name: "Acme Cloud", accent: "#7c3aed", radius: "round", tint: "cool", hide_powered_by: true });
    expect(body.etag).not.toBe(etag);
    expect(contrast(body.palette.light.accent, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(body.palette.dark.accent, "#191919")).toBeGreaterThanOrEqual(4.5);
    const row = await app.deps.storage.db.first<{ data: string; as_instance_admin: number }>("SELECT data, as_instance_admin FROM audit WHERE action = 'branding.update'");
    expect(row?.as_instance_admin).toBe(1);
    expect(JSON.parse(row?.data ?? "{}").fields).toContain("product_name");
    const css = await (await app.call("GET", "/api/branding/theme.css")).text();
    expect(css).toContain("html:root{--accent:");
    expect(css).toContain("html.dark:root{--accent:");
    expect(css).toContain("--r-md:9px");
  });

  it("rejects invalid fields with 422", async () => {
    const { app, admin } = await setup();
    const etag = await etagOf(app);
    const res = await admin.call(
      "PUT",
      "/api/admin/branding",
      { accent: "red", product_name: "x".repeat(41), support_url: "javascript:alert(1)", support_email: "nope", hide_powered_by: "yes", radius: "huge", tint: "pink", login_headline: 5, login_subtitle: "a\u0001", extra: 1 },
      { "if-match": etag },
    );
    expect(res.status).toBe(422);
    const fields = ((await res.json()) as { error: { details: { fields: Record<string, string> } } }).error.details.fields;
    expect(fields).toMatchObject({
      accent: "must_be_hex",
      product_name: "too_long",
      support_url: "must_be_http_url",
      support_email: "must_be_email",
      hide_powered_by: "must_be_boolean",
      radius: "invalid_choice",
      tint: "invalid_choice",
      login_headline: "must_be_string",
      login_subtitle: "invalid_characters",
      extra: "unknown_field",
    });
  });
});

describe("branding assets", () => {
  it("uploads a PNG, serves it cached and cache-busted, then deletes it", async () => {
    const { app, admin } = await setup();
    const res = await admin.call("PUT", "/api/admin/branding/assets/logo-light", { data: b64(PNG) }, { "if-match": await etagOf(app) });
    expect(res.status).toBe(200);
    const view = (await res.json()) as { logo_light_url: string; etag: string };
    expect(view.logo_light_url).toMatch(/^\/api\/branding\/assets\/logo-light\?v=[0-9a-f]{16}$/);
    const img = await app.call("GET", view.logo_light_url);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("cache-control")).toContain("immutable");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
    const plain = await app.call("GET", "/api/branding/assets/logo-light");
    expect(plain.headers.get("cache-control")).toBe("no-cache");
    const cached = await app.call("GET", "/api/branding/assets/logo-light", { headers: { "if-none-match": plain.headers.get("etag") ?? "" } });
    expect(cached.status).toBe(304);
    const audit = await app.deps.storage.db.first("SELECT action FROM audit WHERE action = 'branding.asset_update'");
    expect(audit).not.toBeNull();

    const del = await admin.call("DELETE", "/api/admin/branding/assets/logo-light", undefined, { "if-match": view.etag });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { logo_light_url: unknown }).logo_light_url).toBeNull();
  });

  it("serves an SVG with a sandbox CSP", async () => {
    const { app, admin } = await setup();
    const data = b64(svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect style="fill:red" width="1" height="1"/></svg>'));
    const res = await admin.call("PUT", "/api/admin/branding/assets/icon", { data }, { "if-match": await etagOf(app) });
    expect(res.status).toBe(200);
    const img = await app.call("GET", "/api/branding/assets/icon");
    expect(img.headers.get("content-type")).toBe("image/svg+xml");
    expect(img.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'");
  });

  it("rejects unsupported, oversize, malformed and active-content uploads", async () => {
    const { app, admin } = await setup();
    const put = async (kind: string, data: string) => admin.call("PUT", `/api/admin/branding/assets/${kind}`, { data }, { "if-match": await etagOf(app) });
    expect((await put("banner", b64(PNG))).status).toBe(404);
    expect(await errCode(await put("icon", "!!!"))).toBe("invalid");
    expect(await errCode(await put("icon", b64(svg("GIF89a not an image"))))).toBe("invalid");
    const big = new Uint8Array(512 * 1024 + 1);
    big.set(PNG);
    expect((await put("icon", b64(big))).status).toBe(413);
    const evil = await put("icon", b64(svg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')));
    expect(evil.status).toBe(422);
    expect(await evil.json()).toMatchObject({ error: { details: { fields: { data: "svg_active_content" } } } });
    const missing = await admin.call("PUT", "/api/admin/branding/assets/icon", { data: b64(PNG) });
    expect(missing.status).toBe(428);
  });

  it("DELETE /api/admin/branding resets fields and images", async () => {
    const { app, admin } = await setup();
    await admin.call("PUT", "/api/admin/branding", { product_name: "Acme" }, { "if-match": await etagOf(app) });
    await admin.call("PUT", "/api/admin/branding/assets/icon", { data: b64(PNG) }, { "if-match": await etagOf(app) });
    const res = await admin.call("DELETE", "/api/admin/branding", undefined, { "if-match": await etagOf(app) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ product_name: "", icon_url: null });
    expect(await app.deps.storage.db.first("SELECT action FROM audit WHERE action = 'branding.reset'")).not.toBeNull();
    expect((await admin.call("DELETE", "/api/admin/branding", undefined, { "if-match": '"x"' })).status).toBe(409);
  });
});

describe("branding helpers", () => {
  it("derives AA palettes and flags adjusted light accents", () => {
    const pale = deriveAccent("#ffee00");
    expect(pale.adjusted).toBe(true);
    expect(contrast(pale.light.accent, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(pale.light.accent, pale.light.pale)).toBeGreaterThanOrEqual(4.5);
    const deep = deriveAccent("#1d4ed8");
    expect(deep.adjusted).toBe(false);
    expect(contrast(deep.dark.accent, deep.dark.onAccent)).toBeGreaterThanOrEqual(4.5);
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("sniffs a crafted run of comments in linear time", () => {
    const start = performance.now();
    expect(sniff(svg("<!--" + "--><!--".repeat(50_000)))).toBeNull();
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("sniffs formats by magic bytes", () => {
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniff(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("image/webp");
    expect(sniff(new Uint8Array([0, 0, 1, 0, 1, 0, 16]))).toBe("image/x-icon");
    expect(sniff(svg('<?xml version="1.0"?>\n<svg></svg>'))).toBe("image/svg+xml");
    expect(sniff(svg("<!-- a --> <!-- b -->\n<svg viewBox='0 0 1 1'/>"))).toBe("image/svg+xml");
    expect(sniff(svg("<!-- never closed <svg>"))).toBeNull();
    expect(sniff(svg("<svgx></svgx>"))).toBeNull();
    expect(sniff(new Uint8Array([0xc3, 0x28]))).toBeNull();
  });

  it("refuses SVG with handlers, foreignObject or external refs", () => {
    for (const s of [
      '<svg onload="x()"></svg>',
      "<svg><foreignObject/></svg>",
      '<svg><image href="https://evil.test/a.png"/></svg>',
      '<svg><a xlink:href="javascript:x"/></svg>',
      "<svg><style>@import 'x.css';</style></svg>",
    ]) {
      expect(unsafeSvg(svg(s))).toBe("svg_active_content");
    }
    expect(unsafeSvg(svg('<svg><use href="#a"/></svg>'))).toBeNull();
    expect(unsafeSvg(new Uint8Array([0xc3, 0x28]))).toBe("not_utf8");
  });

  it("emits tint and sharp radius tokens", () => {
    const css = themeCss({ ...DEFAULTS, tint: "warm", radius: "sharp" });
    expect(css).toContain("--r-md:3px");
    expect(css).toContain("html.dark:root{--panel:");
  });
});
