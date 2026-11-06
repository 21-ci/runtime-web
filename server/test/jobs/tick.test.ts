import { describe, expect, it, vi } from "vitest";
import { HOUSEKEEPING_JOBS, scheduled } from "../../src/jobs.ts";
import { runJobs } from "../../src/jobs/runner.ts";
import { ensureMigrated } from "../../src/db/migrate.ts";
import { STATUS_ACTIVE } from "../../src/domains/domains.ts";
import { testApp } from "../harness.ts";
import { hostsCtl } from "../domains/fakes.ts";

// The real housekeeping steps through the runner: budget errors must never look like real failures.

async function setup(fetchStub?: typeof fetch) {
  const rt = hostsCtl();
  const app = testApp({ rtctl: rt, ...(fetchStub ? { fetch: fetchStub } : {}) });
  await ensureMigrated(app.deps.storage.db);
  return { app, db: app.deps.storage.db, rt };
}

describe("scheduled() tick", () => {
  it("migrates first, so a cron firing before any request still works", async () => {
    const app = testApp({ rtctl: hostsCtl() });
    await scheduled(app.deps);
    const row = await app.deps.storage.db.first<{ c: number }>("SELECT count(*) AS c FROM job_state");
    expect(row?.c).toBe(HOUSEKEEPING_JOBS.length);
  });

  it("accepts the tick payload and the old housekeeping payload", async () => {
    const { app, db } = await setup();
    await scheduled(app.deps, { job: "tick" });
    expect((await db.first<{ c: number }>("SELECT count(*) AS c FROM job_state"))?.c).toBeGreaterThan(0);
    await db.run("DELETE FROM job_state");
    await scheduled(app.deps, { job: "housekeeping" });
    expect((await db.first<{ c: number }>("SELECT count(*) AS c FROM job_state"))?.c).toBeGreaterThan(0);
  });

  it("ignores a payload naming an unknown job, without logging it", async () => {
    const { app, db } = await setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await scheduled(app.deps, { job: "s3cret-payload" });
    expect((await db.first<{ c: number }>("SELECT count(*) AS c FROM job_state"))?.c).toBe(0);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("s3cret-payload");
    warn.mockRestore();
  });

  it("an idle tick right after a full one leaves job_state unchanged", async () => {
    const { app, db } = await setup();
    await scheduled(app.deps);
    const before = await db.all("SELECT * FROM job_state ORDER BY name");
    app.tick(1000);
    await scheduled(app.deps);
    expect(await db.all("SELECT * FROM job_state ORDER BY name")).toEqual(before);
  });
});

describe("budget exhaustion in the real steps", () => {
  it("a key revoke refused by the budget stays queued with no attempt charged", async () => {
    const { app, db } = await setup();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = app.deps.now();
    await db.run("INSERT INTO pending_key_revokes (runtime_key_id, tenant_id, attempts, next_at) VALUES ('k1', 't', 0, ?), ('k2', 't', 0, ?)", [now, now + 1]);
    app.tick(1);
    await runJobs(app.deps, HOUSEKEEPING_JOBS.filter((j) => j.name === "key_revokes"), { wallMs: 20_000, fetches: 1 });
    const rows = await db.all<{ runtime_key_id: string; attempts: number; next_at: number }>("SELECT * FROM pending_key_revokes");
    expect(rows).toEqual([{ runtime_key_id: "k2", tenant_id: "t", attempts: 0, next_at: now + 1 }]);
    const st = await db.first<{ last_error: string }>("SELECT last_error FROM job_state WHERE name = 'key_revokes'");
    expect(st?.last_error).toBe("budget_exhausted");
    err.mockRestore();
  });

  it("an active domain never gets a TXT miss because the budget ran out", async () => {
    const stub: typeof fetch = async () => new Response(JSON.stringify({ Status: 3 }));
    const { app, db } = await setup(stub);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await db.run("PRAGMA foreign_keys = OFF");
    await db.run(
      "INSERT INTO domains (id, org_id, app_slug, host, txt_token, status, created_at, service_id, txt_misses) VALUES ('d1','o','s','a.example.com','tok',?,0,'svc_1',2)",
      [STATUS_ACTIVE],
    );
    await runJobs(app.deps, HOUSEKEEPING_JOBS.filter((j) => j.name === "domain_checker"), { wallMs: 20_000, fetches: 0 });
    const row = await db.first<{ status: string; txt_misses: number; last_checked_at: number | null }>("SELECT status, txt_misses, last_checked_at FROM domains");
    expect(row).toEqual({ status: STATUS_ACTIVE, txt_misses: 2, last_checked_at: null });
    const st = await db.first<{ last_error: string }>("SELECT last_error FROM job_state WHERE name = 'domain_checker'");
    expect(st?.last_error).toBe("budget_exhausted");
    err.mockRestore();
    warn.mockRestore();
  });
});
