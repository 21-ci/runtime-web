// R4 git deploy journey: real rt, console and Gitea (git-deploy/stack.ts). The harness lets exactly GITEA_LOCAL
// through rt and the console; the refusal cases check that any other private origin stays refused.
import { createHmac } from "node:crypto";
import { expect, request, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { GITEA_LOCAL, GITEA_PASSWORD, GITEA_USER } from "./git-deploy/stack";

const env = (n: string) => process.env[n] ?? "";
const CONSOLE = () => env("GIT_E2E_CONSOLE");
const PUBLIC = GITEA_LOCAL;
const PRIVATE_OTHER = ["https://localhost:13443", "https://127.0.0.1:13444", "https://10.0.0.1"];
const ORG = "git-org";
const PROJECT = "web";

const code = (tag: string) => `export default {
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname.endsWith("/slow")) await new Promise((r) => setTimeout(r, 6000));
    return Response.json({ tag: "${tag}" });
  },
};`;

let web: APIRequestContext;
let git: APIRequestContext;
let csrf = "";

async function okJson(r: APIResponse, what: string) {
  if (!r.ok()) throw new Error(`${what}: ${r.status()} ${(await r.text()).slice(0, 300)}`);
  return r.status() === 204 ? null : r.json();
}
const call = (method: string, path: string, data?: unknown, headers: Record<string, string> = {}) =>
  web.fetch(CONSOLE() + path, { method, data, headers: { Origin: CONSOLE(), "X-CSRF-Token": csrf, ...headers }, maxRedirects: 0 });
const appPath = (app: string) => `/api/orgs/${ORG}/apps/${app}`;

async function createApp(slug: string) {
  await okJson(await call("POST", `/api/orgs/${ORG}/apps`, { project: PROJECT, environment: "production", slug, template: "http" }), "app");
}

/** Creates or updates one file through Gitea: a real commit, and a real signed push webhook. Returns the sha. */
async function commit(repo: string, branch: string, tag: string): Promise<string> {
  const path = `/api/v1/repos/${repo}/contents/main.ts`;
  const cur = await git.get(`${path}?ref=${branch}`);
  const sha = cur.ok() ? (await cur.json()).sha : undefined;
  const content = Buffer.from(code(tag)).toString("base64");
  const r = await git.fetch(path, { method: sha ? "PUT" : "POST", data: { content, branch, message: `tag ${tag}`, ...(sha ? { sha } : {}) } });
  return (await okJson(r, "commit")).commit.sha;
}

async function linkRepo(app: string, repo: string, token: string) {
  const out = await okJson(await call("POST", `${appPath(app)}/git`, { provider: "gitea", base_url: PUBLIC, repo, branch: "main", token }), "link");
  const url = out.webhook_url.replace(CONSOLE(), env("GIT_E2E_HOOK_HOST"));
  const hook = await okJson(await git.post(`/api/v1/repos/${repo}/hooks`, {
    data: { type: "gitea", active: true, events: ["push"], config: { url, content_type: "json", secret: out.hook_secret } },
  }), "gitea hook");
  return { ...out, giteaHook: hook.id as number };
}

async function delivery(app: string, sha: string, state: string) {
  await expect.poll(async () => {
    const { deliveries } = await okJson(await call("GET", `${appPath(app)}/git`), "git");
    type D = { sha: string; head_sha?: string | null; state: string };
    // A webhook resolves the branch's head when it runs, so an earlier hook may deploy this commit and its own then
    // skips as already deployed. Either way the commit was deployed by the delivery whose head it is.
    if (state === "deployed" && deliveries.some((d: D) => d.head_sha === sha && d.state === "deployed")) return state;
    return deliveries.find((d: D) => d.sha === sha)?.state;
  }, { timeout: 180_000, intervals: [2000], message: `delivery ${app} ${sha} ${state}` }).toBe(state).catch(async (e) => {
    console.log(`${app} deliveries:`, JSON.stringify((await okJson(await call("GET", `${appPath(app)}/git`), "git")).deliveries));
    throw e;
  });
}

const served = async (slug: string, path = "") => (await (await web.get(`${env("GIT_E2E_INVOKE")}/s/${slug}/${path}`)).json()).tag as string;

test.describe.serial("git deploy", () => {
  test.beforeAll(async () => {
    web = await request.newContext();
    git = await request.newContext({
      baseURL: GITEA_LOCAL,
      ignoreHTTPSErrors: true, // the harness's own calls to the throwaway local CA
      httpCredentials: { username: GITEA_USER, password: GITEA_PASSWORD, send: "always" },
    });
    const admin = { email: "admin@git.test", name: "Git Admin", password: "git-admin-passphrase-1" };
    const setup = await web.post(`${CONSOLE()}/api/setup`, { data: { setup_token: env("GIT_E2E_SETUP"), ...admin }, headers: { Origin: CONSOLE() } });
    const me = await okJson(setup, "setup");
    csrf = me.csrf;
    await okJson(await call("POST", "/api/admin/orgs", { slug: ORG, name: "Git Org", owner_user_id: me.user.id }), "org");
    await okJson(await call("POST", `/api/orgs/${ORG}/projects`, { slug: PROJECT }), "project");
    await okJson(await git.post("/api/v1/user/repos", { data: { name: "site", auto_init: true, default_branch: "main" } }), "repo");
  });

  test("a private Gitea is refused: console base_url", async () => {
    await createApp("refused");
    for (const base_url of [...PRIVATE_OTHER, "http://example.com"]) {
      const r = await call("POST", `${appPath("refused")}/git`, { provider: "gitea", base_url, repo: "e2e/site", branch: "main" });
      expect(r.status(), base_url).toBe(422);
    }
  });

  test("a private Gitea is refused: rt from-url, over TLS from a local CA", async () => {
    const auth = { authorization: `Bearer ${env("GIT_E2E_ROOT")}` };
    const ctl = env("GIT_E2E_CONTROL");
    const tenants = await okJson(await web.get(`${ctl}/v1/tenants?limit=100`, { headers: auth }), "tenants");
    const scoped = { ...auth, "x-rt-tenant": tenants.items.find((t: { name: string }) => t.name === "runtime-web").id };
    const svc = await okJson(await web.post(`${ctl}/v1/services`, { headers: scoped, data: { slug: "fromurl", runtime: "deno", name: "from-url" } }), "service");
    const url = `https://localhost:13443/api/v1/repos/${GITEA_USER}/site/archive/main.tar.gz`;
    const v = await okJson(await web.post(`${ctl}/v1/services/${svc.id}/versions/from-url`, { headers: { ...scoped, "idempotency-key": "fromurl-private" }, data: { url, strip_components: 1 } }), "from-url");
    await expect.poll(async () => {
      const cur = await okJson(await web.get(`${ctl}/v1/services/${svc.id}/versions/${v.version}`, { headers: scoped }), "version");
      return cur.failure?.code;
    }, { timeout: 30_000 }).toBe("egress_denied");
  });

  test("a tampered signature is refused and leaves no delivery", async () => {
    await createApp("tamper");
    // The refusal is decided before any call to the host, so any public name serves here.
    const out = await okJson(await call("POST", `${appPath("tamper")}/git`, { provider: "gitea", base_url: "https://example.com", repo: "e2e/site", branch: "main" }), "link");
    const body = JSON.stringify({ ref: "refs/heads/main", after: "a".repeat(40), repository: { full_name: "e2e/site", fork: false } });
    const sign = (b: string, key: string) => createHmac("sha256", key).update(b).digest("hex");
    const send = (b: string, sig: string) => web.post(out.webhook_url, { data: b, headers: { "content-type": "application/json", "x-gitea-event": "push", "x-gitea-signature": sig, "x-gitea-delivery": "d1" } });
    for (const sig of [sign(body, "wrong-secret"), sign(`${body} `, out.hook_secret), "", "00"]) {
      expect((await send(body, sig)).status()).toBe(404);
    }
    const { deliveries } = await okJson(await call("GET", `${appPath("tamper")}/git`), "git");
    expect(deliveries).toEqual([]);
  });

  test.describe("against the local Gitea", () => {
    const APP = "site";
    let link: { hook_secret: string; webhook_url: string; giteaHook: number };
    let token = "";
    let v1 = "";
    let v2 = "";
    let featSha = "";

    test("link repo, signed push, from-url fetch, build, activate, commit status", async () => {
      token = (await okJson(await git.post(`/api/v1/users/${GITEA_USER}/tokens`, { data: { name: "deploy", scopes: ["write:repository", "read:user"] } }), "token")).sha1;
      await createApp(APP);
      link = await linkRepo(APP, "e2e/site", token);
      v1 = await commit("e2e/site", "main", "v1");
      await delivery(APP, v1, "deployed");
      expect(await served(APP)).toBe("v1");
      const { items } = await okJson(await call("GET", `${appPath(APP)}/versions`), "versions");
      expect(items.find((v: { meta?: { git?: { sha?: string } } }) => v.meta?.git?.sha === v1)?.build_state).toBe("ready");
      const statuses = await okJson(await git.get(`/api/v1/repos/e2e/site/statuses/${v1}`), "statuses");
      expect(statuses.map((s: { status: string }) => s.status)).toContain("success");
    });

    test("branch rule deploys to a branch service, live stays", async () => {
      await okJson(await call("PUT", `${appPath(APP)}/git/rules`, { rules: [{ ref_pattern: "feature/*", branch_name: "feat" }] }), "rules");
      await okJson(await git.post("/api/v1/repos/e2e/site/branches", { data: { new_branch_name: "feature/a", old_branch_name: "main" } }), "branch");
      featSha = await commit("e2e/site", "feature/a", "feat");
      await delivery(APP, featSha, "deployed");
      expect(await served(APP)).toBe("v1");
      const { items } = await okJson(await call("GET", `${appPath(APP)}/branches`), "branches");
      expect(items.map((b: { name?: string }) => b.name)).toContain("feat");
    });

    test("switch: the old request finishes on the old version", async () => {
      const slow = web.get(`${env("GIT_E2E_INVOKE")}/s/${APP}/slow`, { timeout: 30_000 });
      await new Promise((r) => setTimeout(r, 1000));
      const app = await call("GET", appPath(APP));
      const etag = app.headers().etag ?? "";
      await okJson(await call("POST", `${appPath(APP)}/switch`, { branch: "feat" }, { "If-Match": etag }), "switch");
      await expect.poll(() => served(APP), { timeout: 30_000 }).toBe("feat");
      const old = await slow;
      expect(old.status()).toBe(200);
      expect((await old.json()).tag).toBe("v1");
    });

    test("a replayed webhook cannot roll back", async () => {
      // v1's push again, correctly signed, after main moved on. Gitea 1.24 has no API for its sent payloads, so the
      // body is rebuilt with the fields the console reads; the signature is what a recorded replay would carry.
      const replayed = JSON.stringify({ ref: "refs/heads/main", after: v1, repository: { full_name: "e2e/site", fork: false } });
      v2 = await commit("e2e/site", "main", "v2");
      await delivery(APP, v2, "deployed");
      expect(await served(APP)).toBe("v2");
      const sig = createHmac("sha256", link.hook_secret).update(replayed).digest("hex");
      const r = await web.post(link.webhook_url, { data: replayed, headers: { "content-type": "application/json", "x-gitea-event": "push", "x-gitea-signature": sig, "x-gitea-delivery": "replay" } });
      expect(r.status()).toBe(202);
      await delivery(APP, v1, "skipped");
      expect(await served(APP)).toBe("v2");
    });

    test("auto_switch fires on the origin repo and never on a fork", async () => {
      // Positive control: the same rule does switch for the repository itself.
      await okJson(await call("PUT", `${appPath(APP)}/git/rules`, { rules: [{ ref_pattern: "feature/*", branch_name: "feat", auto_switch: true }] }), "rules");
      const auto = await commit("e2e/site", "feature/a", "auto");
      await delivery(APP, auto, "deployed");
      await expect.poll(() => served(APP), { timeout: 60_000 }).toBe("auto");

      await okJson(await git.post("/api/v1/orgs", { data: { username: "forks" } }), "org");
      await okJson(await git.post("/api/v1/repos/e2e/site/forks", { data: { organization: "forks", name: "site" } }), "fork");
      await createApp("forked");
      await linkRepo("forked", "forks/site", token);
      const main = await commit("forks/site", "main", "fork-main");
      await delivery("forked", main, "deployed");
      await okJson(await call("PUT", `${appPath("forked")}/git/rules`, { rules: [{ ref_pattern: "feature/*", branch_name: "feat", auto_switch: true }] }), "rules");
      const sha = await commit("forks/site", "feature/a", "fork-feat");
      await delivery("forked", sha, "deployed");
      await new Promise((r) => setTimeout(r, 10_000));
      expect(await served("forked")).toBe("fork-main");
      const switches = await okJson(await call("GET", `${appPath("forked")}/switches`), "switches");
      expect(switches.items.filter((s: { branch?: string }) => s.branch === "feat")).toEqual([]);
    });
  });
});
