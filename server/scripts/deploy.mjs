#!/usr/bin/env node
// Deploys server/src as the runtime service `rtweb` and checks GET /api/healthz.
//
//   RT_ROOT_TOKEN=... node scripts/deploy.mjs
//
// Env: RT_API (default http://127.0.0.1:8081), RT_INVOKE (http://127.0.0.1:8080),
// RTWEB_TENANT (tenant name, "runtime-web"), RTWEB_SLUG ("rtweb"), RTWEB_PLAN ("free").
// Idempotent: reuses the tenant and service, uploads a new version, activates it.
// The token is read from the environment only and never printed.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.RT_API ?? "http://127.0.0.1:8081";
const INVOKE = process.env.RT_INVOKE ?? "http://127.0.0.1:8080";
const TOKEN = process.env.RT_ROOT_TOKEN;
const TENANT = process.env.RTWEB_TENANT ?? "runtime-web";
const SLUG = process.env.RTWEB_SLUG ?? "rtweb";
const PLAN = process.env.RTWEB_PLAN ?? "free";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

if (!TOKEN) {
  console.error("RT_ROOT_TOKEN is required");
  process.exit(2);
}

async function api(method, path, { body, tenant, raw } = {}) {
  const headers = { authorization: `Bearer ${TOKEN}` };
  if (tenant) headers["x-rt-tenant"] = tenant;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (raw) return { status: res.status, text };
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function ensureTenant() {
  for (let cursor = ""; ; ) {
    const page = await api("GET", `/v1/tenants?limit=100${cursor ? `&cursor=${cursor}` : ""}`);
    const hit = page.items.find((t) => t.name === TENANT);
    if (hit) return hit.id;
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  const t = await api("POST", "/v1/tenants", { body: { name: TENANT, plan: PLAN } });
  console.log(`created tenant ${t.id}`);
  return t.id;
}

async function ensureService(tenant) {
  const page = await api("GET", `/v1/services?slug=${SLUG}`, { tenant });
  if (page.items.length > 0) return page.items[0].id;
  const s = await api("POST", "/v1/services", { tenant, body: { slug: SLUG, runtime: "deno", name: "Runtime Web" } });
  console.log(`created service ${s.id}`);
  return s.id;
}

async function collect(dir) {
  const out = {};
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, await collect(p));
    else if (/\.(ts|js|json)$/.test(e.name) && !e.name.endsWith(".d.ts")) out[relative(ROOT, p)] = await readFile(p, "utf8");
  }
  return out;
}

async function main() {
  const tenant = await ensureTenant();
  const svc = await ensureService(tenant);
  const rt = JSON.parse(await readFile(join(ROOT, "rt.json"), "utf8"));
  const files = await collect(join(ROOT, "src"));
  const v = await api("POST", `/v1/services/${svc}/versions?activate=1&compile=eager`, {
    tenant,
    body: { entry: rt.entry, files, ...(rt.imports ? { imports: rt.imports } : {}) },
  });
  const num = v.version ?? v.version_no ?? v.id;
  console.log(`uploaded version ${num} (${Object.keys(files).length} files)`);
  for (let i = 0; i < 60; i++) {
    const s = await api("GET", `/v1/services/${svc}/versions/${num}`, { tenant });
    if (s.build_state === "ready") break;
    if (s.build_state === "failed") throw new Error(`build failed: ${JSON.stringify(s.failure)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const res = await fetch(`${INVOKE}/s/${SLUG}/api/healthz`);
  const body = await res.text();
  console.log(`GET ${INVOKE}/s/${SLUG}/api/healthz -> ${res.status} ${body}`);
  if (res.status !== 200) process.exit(1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
