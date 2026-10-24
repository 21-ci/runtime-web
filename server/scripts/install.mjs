#!/usr/bin/env node
// Fresh-install bootstrap of Runtime Web on a 21 Cloud Runtime node (docs/design/backend-on-runtime.md §5).
//
//   RT_ROOT_TOKEN=... node scripts/install.mjs [--build]
//
// Idempotent: every step reuses what exists. Re-running only uploads a new version when the
// bundle changed, never rotates RTWEB_SEAL_KEY and never reissues RTWEB_SETUP_TOKEN.
// The root token is read from the environment only and never printed.
//
// Env: RT_API (http://127.0.0.1:8081), RT_INVOKE (http://127.0.0.1:8080), RTWEB_TENANT ("runtime-web"),
// RTWEB_SLUG ("rtweb"), RTWEB_PLAN ("rtweb"; falls back to "free" with a warning when the node lacks it),
// RTWEB_ORIGIN (browser origin of the console, default `${RT_INVOKE}`), RTWEB_HOST (console host to map),
// RTWEB_RUNTIME_PUBLIC_URL (public base of app URLs, default `${RT_INVOKE}`), RTWEB_DEFAULT_PLAN (plan for new org
// tenants; the server defaults to "free"),
// RTCTL_SDK_VERSION ("0.1.0").
//
// Steps that need the operator (node config + restart/SIGHUP) are printed, never performed.
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { open, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.RT_API ?? "http://127.0.0.1:8081";
const INVOKE = process.env.RT_INVOKE ?? "http://127.0.0.1:8080";
const TOKEN = process.env.RT_ROOT_TOKEN;
const TENANT = process.env.RTWEB_TENANT ?? "runtime-web";
const SLUG = process.env.RTWEB_SLUG ?? "rtweb";
const WANT_PLAN = process.env.RTWEB_PLAN ?? "rtweb";
const ORIGIN = process.env.RTWEB_ORIGIN ?? INVOKE;
const HOST = process.env.RTWEB_HOST ?? "";
const PUBLIC_URL = process.env.RTWEB_RUNTIME_PUBLIC_URL ?? INVOKE;
const DEFAULT_PLAN = process.env.RTWEB_DEFAULT_PLAN ?? "";
const SDK_VERSION = process.env.RTCTL_SDK_VERSION ?? "0.1.0";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO = join(ROOT, "..");
const BINDINGS = ["rtctl-op", "rtctl-tenant"];

if (!TOKEN) {
  console.error("RT_ROOT_TOKEN is required");
  process.exit(2);
}

const todo = [];
const step = (n, msg) => console.log(`[${n}] ${msg}`);

async function api(method, path, { body, tenant, ok = [] } = {}) {
  const headers = { authorization: `Bearer ${TOKEN}` };
  if (tenant) headers["x-rt-tenant"] = tenant;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok && !ok.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 500)}`);
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}
const get = async (path, o) => (await api("GET", path, o)).data;

// 1. node config: plan + bindings
async function checkNode() {
  const plans = await get("/v1/plans");
  const cfg = await get("/v1/node/config");
  const have = new Set((cfg.binding ?? []).map((b) => b.name));
  const missing = BINDINGS.filter((b) => !have.has(b));
  const planOk = plans.some((p) => p.name === WANT_PLAN);
  if (!planOk || missing.length) {
    const what = [!planOk && `plan "${WANT_PLAN}"`, missing.length && `bindings ${missing.join(", ")}`].filter(Boolean).join(" and ");
    step(1, `node config lacks ${what}`);
    todo.push(
      `Merge deploy/rt.rtweb.toml into the node's rt.toml, export RTWEB_OP_TOKEN and RTWEB_RELAY_SECRET in the node's ` +
        `environment, then restart rt (SIGHUP reloads plans and bindings), and re-run this script.`,
    );
  } else step(1, `node config ok (plan ${WANT_PLAN}, bindings ${BINDINGS.join(", ")})`);
  const plan = planOk ? WANT_PLAN : "free";
  if (!planOk) console.log(`    using plan "free" for now`);
  const settings = plans.find((p) => p.name === plan)?.settings ?? {};
  return { plan, cron: (settings.allowed_triggers ?? []).includes("cron") };
}

// 3. tenant
async function ensureTenant(plan) {
  for (let cursor = ""; ; ) {
    const page = await get(`/v1/tenants?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const hit = page.items.find((t) => t.name === TENANT);
    if (hit) {
      step(3, `tenant ${TENANT} exists (${hit.id}, plan ${hit.plan})`);
      if (hit.plan !== plan) todo.push(`Tenant ${hit.id} is on plan "${hit.plan}", expected "${plan}": PATCH /v1/tenants/${hit.id} {"plan":"${plan}"}.`);
      return hit.id;
    }
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  const { data } = await api("POST", "/v1/tenants", { body: { name: TENANT, plan } });
  step(3, `created tenant ${TENANT} (${data.id})`);
  return data.id;
}

// 4. operator SDK rtctl (written by T2 at server/sdk/rtctl/mod.ts)
async function ensureSdk(tenantId) {
  const src = join(ROOT, "sdk", "rtctl", "mod.ts");
  if (!existsSync(src)) {
    step(4, "sdk/rtctl/mod.ts not present yet: SDK publish skipped");
    todo.push("Re-run once server/sdk/rtctl exists to publish and grant the rtctl SDK.");
    return;
  }
  const source = (await readFile(src)).toString("base64");
  const r = await api("POST", "/v1/sdks", { body: { name: "rtctl", version: SDK_VERSION, source, description: "Runtime Web control API" }, ok: [409] });
  step(4, r.status === 409 ? `sdk rtctl ${SDK_VERSION} already published` : `published sdk rtctl ${SDK_VERSION}`);
  await api("PUT", "/v1/sdk-grants", { body: { scope: `tenant:${tenantId}`, sdk: "rtctl", effect: "allow" } });
  await api("PUT", "/v1/sdk-grants", { body: { scope: "node", sdk: "rtctl", effect: "deny" } });
  step(4, `sdk grants: allow tenant:${tenantId}, deny node`);
}

// 5. service, env, secrets
async function ensureService(tenant, cron) {
  const triggers = { http: true, cron, interval: false, queue: false, call: false, websocket: false };
  const page = await get(`/v1/services?slug=${SLUG}`, { tenant });
  let svc = page.items[0];
  if (svc) step(5, `service ${SLUG} exists (${svc.id})`);
  else {
    svc = (await api("POST", "/v1/services", { tenant, body: { slug: SLUG, runtime: "deno", name: "Runtime Web", triggers } })).data;
    step(5, `created service ${SLUG} (${svc.id})`);
  }
  if (!cron) todo.push(`Plan lacks the cron trigger: the housekeeping schedule (*/5 * * * *) is not created.`);
  else {
    const scheds = await get(`/v1/services/${svc.id}/schedules`, { tenant });
    if (!(Array.isArray(scheds) ? scheds : scheds.items ?? []).some((s) => s.name === "housekeeping")) {
      await api("POST", `/v1/services/${svc.id}/schedules`, { tenant, body: { name: "housekeeping", cron: "*/5 * * * *" } });
      step(5, "created schedule housekeeping (*/5 * * * *)");
    }
  }
  const secrets = new Set((await get(`/v1/services/${svc.id}/secrets`, { tenant })).map((s) => s.name));
  const put = (n, value) => api("PUT", `/v1/services/${svc.id}/secrets/${n}`, { tenant, body: { value } });
  if (!secrets.has("RTWEB_SEAL_KEY")) {
    await put("RTWEB_SEAL_KEY", randomBytes(32).toString("base64"));
    step(5, "set secret RTWEB_SEAL_KEY (new random key)");
  }
  let setupToken = null;
  if (!secrets.has("RTWEB_SETUP_TOKEN")) {
    setupToken = randomBytes(24).toString("base64url");
    await put("RTWEB_SETUP_TOKEN", setupToken);
    step(5, "set secret RTWEB_SETUP_TOKEN (new)");
  }
  // Rotated every run: authorises this run's large-asset uploads only.
  const assetToken = randomBytes(24).toString("base64url");
  await put("RTWEB_ASSET_TOKEN", assetToken);
  return { svc, setupToken, assetToken };
}

async function setEnv(tenant, svc, extra) {
  const env = (await get(`/v1/services/${svc.id}/env`, { tenant })) ?? {};
  const next = {
    ...env,
    RTWEB_ORIGIN: ORIGIN,
    RTWEB_RUNTIME_PUBLIC_URL: PUBLIC_URL,
    ...(DEFAULT_PLAN ? { RTWEB_DEFAULT_PLAN: DEFAULT_PLAN } : {}),
    ...extra,
  };
  if (JSON.stringify(Object.entries(env).sort()) !== JSON.stringify(Object.entries(next).sort())) {
    await api("PUT", `/v1/services/${svc.id}/env`, { tenant, body: next });
    step(5, `env set (${Object.keys(next).sort().join(", ")})`);
  }
  return env;
}

async function collect(dir) {
  const out = {};
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, await collect(p));
    else if (/\.(ts|js)$/.test(e.name) && !e.name.endsWith(".d.ts")) out[relative(ROOT, p)] = await readFile(p, "utf8");
  }
  return out;
}

// 6. assets + bundle
async function deploy(tenant, svc, oldEnv) {
  if (process.argv.includes("--build")) {
    step(6, "building web/dist");
    execFileSync("npm", ["ci"], { cwd: join(REPO, "web"), stdio: "inherit" });
    execFileSync("npm", ["run", "build"], { cwd: join(REPO, "web"), stdio: "inherit" });
  }
  if (!existsSync(join(REPO, "web", "dist", "index.html"))) throw new Error("web/dist missing: run with --build or `make web` first");
  execFileSync(process.execPath, [join(ROOT, "scripts", "gen-assets.mjs")], { stdio: "inherit" });
  const rt = JSON.parse(await readFile(join(ROOT, "rt.json"), "utf8"));
  const files = await collect(join(ROOT, "src"));
  const hash = createHash("sha256");
  for (const k of Object.keys(files).sort()) hash.update(k).update("\0").update(files[k]).update("\0");
  const digest = hash.digest("hex").slice(0, 16);
  const live = (await get(`/v1/services/${svc.id}`, { tenant })).live_version;
  if (live && oldEnv.RTWEB_BUNDLE === digest) {
    step(6, `bundle ${digest} already live (version ${live})`);
    return digest;
  }
  const { data: v } = await api("POST", `/v1/services/${svc.id}/versions?activate=1&compile=eager`, {
    tenant,
    body: { entry: rt.entry, files, ...(rt.imports ? { imports: rt.imports } : {}) },
  });
  const num = v.version ?? v.version_no ?? v.id;
  step(6, `uploaded version ${num} (${Object.keys(files).length} files, bundle ${digest})`);
  for (let i = 0; ; i++) {
    const s = await get(`/v1/services/${svc.id}/versions/${num}`, { tenant });
    if (s.build_state === "ready") break;
    if (s.build_state === "failed") throw new Error(`build failed: ${JSON.stringify(s.failure)}`);
    if (i > 120) throw new Error("build did not finish in 60 s");
    await new Promise((r) => setTimeout(r, 500));
  }
  step(6, `version ${num} ready and live`);
  return digest;
}

async function uploadBlobs(assetToken) {
  const blobs = JSON.parse(await readFile(join(ROOT, ".gen-blobs.json"), "utf8"));
  for (const b of blobs) {
    const id = b.etag.replace(/"/g, "");
    const fh = await open(b.file);
    try {
      for (let i = 0; i < b.parts; i++) {
        const buf = Buffer.alloc(Math.min(b.partBytes, b.size - i * b.partBytes));
        await fh.read(buf, 0, buf.length, i * b.partBytes);
        const res = await fetch(`${INVOKE}/s/${SLUG}/api/internal/assets/${id}/${i}`, {
          method: "PUT",
          headers: { "x-rtweb-asset-token": assetToken, "content-type": "application/octet-stream" },
          body: buf,
        });
        if (res.status !== 204) throw new Error(`asset ${b.path} part ${i} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
      }
    } finally {
      await fh.close();
    }
    step(6, `uploaded ${b.path} to std:blob (${b.parts} parts, ${b.size} B)`);
  }
}

async function smoke() {
  const base = `${INVOKE}/s/${SLUG}`;
  const check = async (path, want) => {
    const res = await fetch(base + path);
    const body = await res.text();
    const ok = want(res, body);
    step(8, `GET ${base}${path} -> ${res.status} ${ok ? "ok" : "UNEXPECTED " + body.slice(0, 120)}`);
    return { ok, res, body };
  };
  const h = await check("/api/healthz", (r) => r.status === 200);
  const idx = await check("/", (r, b) => r.status === 200 && b.includes("<base href="));
  const asset = /src="[^"]*(\/assets\/[^"]+\.js)"/.exec(idx.body)?.[1];
  const a = asset ? await check(asset, (r) => r.status === 200 && (r.headers.get("cache-control") ?? "").includes("immutable")) : { ok: false };
  const s = await check("/api/setup", (r) => r.status === 200 || r.status === 404);
  if (s.res.status === 404) todo.push("GET /api/setup is not registered yet (task T4); first-run setup needs it.");
  return h.ok && idx.ok && a.ok;
}

async function main() {
  const { plan, cron } = await checkNode();
  step(2, "relay + TLS: see deploy/Caddyfile (operator installs it next to the node)");
  const tenant = await ensureTenant(plan);
  await ensureSdk(tenant);
  const { svc, setupToken, assetToken } = await ensureService(tenant, cron);
  const oldEnv = await setEnv(tenant, svc, {});
  const digest = await deploy(tenant, svc, oldEnv);
  await setEnv(tenant, svc, { RTWEB_BUNDLE: digest });
  await uploadBlobs(assetToken);
  if (HOST) {
    await api("PUT", `/v1/services/${svc.id}/hosts/${HOST}`, { tenant });
    step(7, `mapped host ${HOST} -> ${SLUG}`);
  } else step(7, `no RTWEB_HOST: map the console host later with PUT /v1/services/${svc.id}/hosts/console.<domain>`);
  const ok = await smoke();
  console.log("");
  if (setupToken) {
    console.log(`First-run setup: open ${HOST ? `https://${HOST}` : `${INVOKE}/s/${SLUG}`}/setup`);
    console.log(`Setup token (shown once): ${setupToken}`);
    console.log("After setup, delete it: DELETE /v1/services/" + svc.id + "/secrets/RTWEB_SETUP_TOKEN");
  } else {
    console.log(`Console: ${HOST ? `https://${HOST}` : `${INVOKE}/s/${SLUG}`}/ (setup token was issued by an earlier run; delete the secret and re-run to reissue)`);
  }
  if (todo.length) {
    console.log("\nOperator steps remaining:");
    for (const t of todo) console.log(`  - ${t}`);
  }
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
