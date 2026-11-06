import { describe, expect, it } from "vitest";
import { world } from "./apps/helpers.ts";
import { addUser } from "./auth/helpers.ts";
import { runJobs } from "../src/jobs/runner.ts";
import { HOUSEKEEPING_JOBS } from "../src/jobs.ts";
import { TELEMETRY_USERS_JOB } from "../src/telemetry/telemetry.ts";

describe("telemetry user count", () => {
  it("is a daily housekeeping job", () => {
    expect(HOUSEKEEPING_JOBS).toContain(TELEMETRY_USERS_JOB);
    expect(TELEMETRY_USERS_JOB.everyMs).toBe(24 * 3_600_000);
  });

  it("gives the runtime the count over the operator binding and sends nothing else anywhere", async () => {
    const w = await world();
    const before = (await w.app.deps.storage.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM users"))?.n ?? 0;
    await addUser(w.app, "extra@x.test");
    let fetched = false;
    const deps = { ...w.app.deps, fetch: (async () => ((fetched = true), new Response())) as typeof fetch };
    await runJobs(deps, [TELEMETRY_USERS_JOB]);
    expect(w.fake.consoleUsers).toBe(before + 1);
    const call = w.fake.calls.find((c) => c.path === "/v1/telemetry/console");
    expect(call).toMatchObject({ scope: "op", method: "PUT" });
    expect(fetched).toBe(false);
  });

  it("ignores a failure and does not count as a job error", async () => {
    const w = await world();
    w.fake.telemetryError = 503;
    const report = await runJobs(w.app.deps, [TELEMETRY_USERS_JOB]);
    expect(report.ran).toContain("telemetry_users");
    const row = await w.app.deps.storage.db.first<{ last_error: string | null }>("SELECT last_error FROM job_state WHERE name = ?", ["telemetry_users"]);
    expect(row?.last_error ?? null).toBeNull();
  });
});

describe("GET /api/admin/telemetry", () => {
  it("tells an instance admin whether the node sends reports", async () => {
    const w = await world();
    const on = await w.admin.call("GET", "/api/admin/telemetry");
    expect(await on.json()).toEqual({ sending: true });
    w.fake.telemetrySending = false;
    expect(await (await w.admin.call("GET", "/api/admin/telemetry")).json()).toEqual({ sending: false });
  });

  it("says unknown, without failing, when the node does not answer", async () => {
    const w = await world();
    w.fake.telemetryError = 403;
    const res = await w.admin.call("GET", "/api/admin/telemetry");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sending: null });
  });

  it("is instance-admin only", async () => {
    const w = await world();
    const member = await w.user("member@x.test", "member");
    expect((await member.call("GET", "/api/admin/telemetry")).status).toBe(403);
  });
});
