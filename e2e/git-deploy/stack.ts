// Stack for git-deploy.spec.ts: a real `rt` (../runtime/target/debug/rt) on its own ports and data directory,
// Caddy as the console edge and tenant relay, the console installed by server/scripts/install.mjs, and a pinned
// Gitea container serving TLS from a throwaway local CA. Everything goes away in the returned teardown.
//
// rt refuses non-public addresses and the console refuses a private base_url. Two test-only switches let exactly
// this Gitea through: RT_TEST_LOCAL_ORIGIN and RT_TEST_LOCAL_CA_FILE (debug builds of rt only, absent from release;
// see SECURITY.md there) and RTWEB_TEST_GIT_ORIGIN (with RTWEB_INSECURE_COOKIES). Any other private origin is still
// refused, which the spec checks.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const GITEA_IMAGE = "gitea/gitea:1.24.6";
export const GITEA_NAME = "rtweb-e2e-gitea";
export const GITEA_LOCAL = "https://127.0.0.1:13443";
export const GITEA_USER = "e2e";
export const GITEA_PASSWORD = "e2e-gitea-passphrase-1";
const CONTROL = "127.0.0.1:18081";
const INVOKE = "127.0.0.1:18080";
const EDGE_PORT = 18180;
const RELAY_PORT = 18082;
const CONSOLE_HOST = "console.test";

const WEB = resolve(__dirname, "../..");
const RT = resolve(WEB, "../runtime/target/debug/rt");

const sh = (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

async function until(what: string, ok: () => Promise<boolean>, ms = 90_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`stack: ${what} not ready after ${ms} ms`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(RT)) throw new Error(`stack: ${RT} missing: cargo build -p rt-server --bin rt`);
  if (!existsSync(join(WEB, "web/dist/index.html"))) throw new Error("stack: web/dist missing: run make web");
  const dir = mkdtempSync(join(tmpdir(), "rtweb-git-e2e-"));
  const procs: ChildProcess[] = [];
  const hadImage = sh("docker", ["images", "-q", GITEA_IMAGE]).trim() !== "";
  const teardown = async () => {
    for (const p of procs) p.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    try { sh("docker", ["rm", "-fv", GITEA_NAME]); } catch { /* never started */ }
    if (!hadImage) try { sh("docker", ["rmi", GITEA_IMAGE]); } catch { /* never pulled */ }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    // Local CA and the Gitea certificate.
    const f = (n: string) => join(dir, n);
    sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=rtweb e2e CA", "-keyout", f("ca.key"), "-out", f("ca.pem")]);
    sh("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=gitea", "-keyout", f("key.pem"), "-out", f("c.csr")]);
    writeFileSync(f("ext"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
    sh("openssl", ["x509", "-req", "-days", "1", "-in", f("c.csr"), "-CA", f("ca.pem"), "-CAkey", f("ca.key"), "-CAcreateserial", "-extfile", f("ext"), "-out", f("cert.pem")]);

    const root = GITEA_LOCAL;
    sh("docker", [
      "run", "-d", "--name", GITEA_NAME, "-p", "127.0.0.1:13443:3000", "-v", `${dir}:/certs:ro`,
      "-e", "USER_UID=1000", "-e", "GITEA__security__INSTALL_LOCK=true", "-e", "GITEA__database__DB_TYPE=sqlite3",
      "-e", "GITEA__server__PROTOCOL=https", "-e", "GITEA__server__CERT_FILE=/certs/cert.pem", "-e", "GITEA__server__KEY_FILE=/certs/key.pem",
      "-e", `GITEA__server__ROOT_URL=${root}/`, "-e", "GITEA__webhook__ALLOWED_HOST_LIST=*", "-e", "GITEA__webhook__SKIP_TLS_VERIFY=true",
      "-e", "GITEA__service__DISABLE_REGISTRATION=true", GITEA_IMAGE,
    ]);
    await until("gitea", async () => {
      sh("curl", ["-sfk", `${GITEA_LOCAL}/api/healthz`]);
      return true;
    });
    sh("docker", ["exec", "-u", "git", GITEA_NAME, "gitea", "admin", "user", "create", "--admin", "--username", GITEA_USER, "--password", GITEA_PASSWORD, "--email", "e2e@example.com", "--must-change-password=false"]);

    // The node: dev profile, own ports and data directory, the console's plans and bindings.
    const rootToken = randomBytes(24).toString("hex");
    const relay = randomBytes(32).toString("hex");
    const source = (p: string) => sh("cat", [p]);
    const fragment = source(join(WEB, "deploy/rt.rtweb.toml")).replaceAll("127.0.0.1:8081", CONTROL).replaceAll("127.0.0.1:8082", `127.0.0.1:${RELAY_PORT}`);
    const base = source(resolve(WEB, "../runtime/config/defconfigs/dev.toml"))
      .replace('data_dir = "./data"', `data_dir = "${join(dir, "data")}"`)
      .replace('public = "127.0.0.1:8080"', `public = "${INVOKE}"`)
      .replace('internal = "unix:./data/rt.sock"', `internal = "unix:${join(dir, "data/rt.sock")}"`)
      .replace('control = "127.0.0.1:8081"', `control = "${CONTROL}"`)
      .replace('metrics = "127.0.0.1:9090"', 'metrics = "127.0.0.1:19090"');
    writeFileSync(join(dir, "rt.toml"), `${base}\n${fragment}`);
    const log = openSync(join(tmpdir(), "rtweb-git-e2e-rt.log"), "w");
    procs.push(spawn(RT, ["--config", join(dir, "rt.toml"), "serve"], {
      cwd: dir,
      stdio: ["ignore", log, log],
      env: { ...process.env, RT_ROOT_TOKEN: rootToken, RT_MASTER_KEY: randomBytes(32).toString("hex"), RTWEB_OP_TOKEN: `Bearer ${rootToken}`, RTWEB_RELAY_SECRET: relay, RT_TEST_LOCAL_ORIGIN: GITEA_LOCAL.replace("https://", ""), RT_TEST_LOCAL_CA_FILE: f("ca.pem"), RT_TEST_LOCAL_ORIGIN_GUESTS: "1" },
    }));
    await until("rt", async () => (await fetch(`http://${CONTROL}/v1/version`, { headers: { authorization: `Bearer ${rootToken}` } })).ok);

    // The edge: the console host for every request (webhooks arrive via host.docker.internal) and the relay.
    writeFileSync(join(dir, "Caddyfile"), `{
	admin off
	auto_https off
}
http://:${EDGE_PORT} {
	@internal path /api/internal/* /s/*/api/internal/*
	respond @internal 404
	reverse_proxy ${INVOKE} {
		header_up Host ${CONSOLE_HOST}
		header_up X-Forwarded-For {remote_host}
	}
}
http://127.0.0.1:${RELAY_PORT} {
	bind 127.0.0.1
	@authed {
		header x-relay-auth ${relay}
		header_regexp key x-rtweb-key ^rtk_[A-Za-z0-9_-]+$
	}
	handle @authed {
		reverse_proxy ${CONTROL} {
			header_up Authorization "Bearer {http.request.header.x-rtweb-key}"
			header_up -x-rtweb-key
			header_up -x-relay-auth
			header_up -x-rt-tenant
		}
	}
	handle {
		respond "forbidden" 403
	}
}
`);
    procs.push(spawn("caddy", ["run", "--adapter", "caddyfile", "--config", join(dir, "Caddyfile")], { stdio: "ignore" }));

    const consoleUrl = `http://127.0.0.1:${EDGE_PORT}`;
    await enableDevCookies(rootToken);
    const out = sh(process.execPath, ["scripts/install.mjs"], {
      cwd: join(WEB, "server"),
      env: {
        ...process.env, RT_ROOT_TOKEN: rootToken, RT_API: `http://${CONTROL}`, RT_INVOKE: `http://${INVOKE}`,
        RTWEB_ORIGIN: consoleUrl, RTWEB_HOST: CONSOLE_HOST, RTWEB_APPS_URL: `http://apps.test:18080`, RTWEB_DEFAULT_PLAN: "unlimited",
      },
    });
    const setup = /Setup token \(shown once\): (\S+)/.exec(out)?.[1];
    if (!setup) throw new Error("stack: install.mjs printed no setup token");
    await until("console", async () => (await fetch(`${consoleUrl}/api/setup`)).ok);
    Object.assign(process.env, { GIT_E2E_CONSOLE: consoleUrl, GIT_E2E_INVOKE: `http://${INVOKE}`, GIT_E2E_SETUP: setup, GIT_E2E_ROOT: rootToken, GIT_E2E_CONTROL: `http://${CONTROL}`,GIT_E2E_HOOK_HOST: `http://host.docker.internal:${EDGE_PORT}` });
    return teardown;
  } catch (e) {
    await teardown();
    throw e;
  }
}

/**
 * The local console is on http, which the server accepts only with this development switch (the container image sets
 * it the same way for an http origin). install.mjs has no flag for it but reuses an existing tenant and service and
 * keeps their env, so they are created first. Never set on a real node.
 */
async function enableDevCookies(token: string): Promise<void> {
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = async (path: string, headers: Record<string, string>, body: unknown) => {
    const r = await fetch(`http://${CONTROL}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`stack: ${path} ${r.status} ${await r.text()}`);
    return (await r.json()) as { id: string };
  };
  const t = await post("/v1/tenants", h, { name: "runtime-web", plan: "rtweb" });
  const scoped = { ...h, "x-rt-tenant": t.id };
  const triggers = { http: true, cron: true, interval: false, queue: false, call: false, websocket: false };
  const svc = await post("/v1/services", scoped, { slug: "rtweb", runtime: "deno", name: "Runtime Web", triggers });
  const put = await fetch(`http://${CONTROL}/v1/services/${svc.id}/env`, { method: "PUT", headers: scoped, body: JSON.stringify({ RTWEB_INSECURE_COOKIES: "1", RTWEB_TEST_GIT_ORIGIN: GITEA_LOCAL }) });
  if (!put.ok) throw new Error(`stack: env ${put.status}`);
}
