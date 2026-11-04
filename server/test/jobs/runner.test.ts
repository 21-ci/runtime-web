import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetExhausted } from "../../src/jobs/budget.ts";
import { runJobs, type Job, type RunnerDeps } from "../../src/jobs/runner.ts";
import { ensureMigrated } from "../../src/db/migrate.ts";
import type { Db } from "../../src/storage/types.ts";
import type { RtCtl } from "../../src/runtime/types.ts";
import { memoryStorage, testConfig } from "../harness.ts";

const MIN = 60_000;

interface StateRow {
  name: string;
  next_at: number;
  cursor: string | null;
  last_ok_at: number | null;
  last_error: string | null;
  failures: number;
  [k: string]: unknown;
}

async function setup(over: Partial<RunnerDeps> = {}) {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const fetches: (RequestInit | undefined)[] = [];
  const stub: typeof fetch = async (_url, init) => {
    fetches.push(init);
    return new Response("ok");
  };
  const deps: RunnerDeps = { storage: memoryStorage(now), now, config: testConfig(), fetch: stub, ...over };
  await ensureMigrated(deps.storage.db);
  const state = (name: string) => deps.storage.db.first<StateRow>("SELECT * FROM job_state WHERE name = ?", [name]);
  return { clock, deps, db: deps.storage.db, state, fetches };
}

/** Counts writes that reach the job_state table. */
function countWrites(db: Db): () => number {
  let n = 0;
  const run = db.run.bind(db);
  db.run = (sql, args) => {
    if (/job_state/.test(sql)) n++;
    return run(sql, args);
  };
  return () => n;
}

const job = (name: string, run: Job["run"], everyMs = 5 * MIN): Job => ({ name, everyMs, run });
const LIMITS = { wallMs: 20_000, fetches: 30 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runJobs order and scheduling", () => {
  it("runs due jobs in the given order and records success", async () => {
    const { deps, state, clock } = await setup();
    const seen: string[] = [];
    const report = await runJobs(deps, [job("a", async () => void seen.push("a")), job("b", async () => void seen.push("b"))], LIMITS);
    expect(seen).toEqual(["a", "b"]);
    expect(report.ran).toEqual(["a", "b"]);
    expect(await state("a")).toMatchObject({ next_at: clock.t + 5 * MIN, last_ok_at: clock.t, failures: 0, last_error: null, cursor: null });
  });

  it("does not run a job before next_at and runs it once due", async () => {
    const { deps, clock } = await setup();
    let n = 0;
    const jobs = [job("a", async () => void n++)];
    await runJobs(deps, jobs, LIMITS);
    await runJobs(deps, jobs, LIMITS);
    expect(n).toBe(1);
    clock.t += 5 * MIN;
    await runJobs(deps, jobs, LIMITS);
    expect(n).toBe(2);
  });

  it("writes nothing to job_state when nothing is due", async () => {
    const { deps, db } = await setup();
    const jobs = [job("a", async () => undefined)];
    await runJobs(deps, jobs, LIMITS);
    const writes = countWrites(db);
    const report = await runJobs(deps, jobs, LIMITS);
    expect(report.ran).toEqual([]);
    expect(writes()).toBe(0);
  });

  it("treats a job with no row yet as due, even when the others are not", async () => {
    const { deps } = await setup();
    await runJobs(deps, [job("a", async () => undefined)], LIMITS);
    let ran = false;
    await runJobs(deps, [job("a", async () => undefined), job("new", async () => void (ran = true))], LIMITS);
    expect(ran).toBe(true);
  });

  it("ignores rows of jobs that no longer exist", async () => {
    const { deps, db } = await setup();
    await db.run("INSERT INTO job_state (name, next_at) VALUES ('gone', 0)");
    await runJobs(deps, [job("a", async () => undefined)], LIMITS);
    const writes = countWrites(db);
    expect((await runJobs(deps, [job("a", async () => undefined)], LIMITS)).ran).toEqual([]);
    expect(writes()).toBe(0);
  });

  it("does nothing for an empty job list", async () => {
    const { deps } = await setup();
    expect((await runJobs(deps, [], LIMITS)).ran).toEqual([]);
  });
});

describe("runJobs failures", () => {
  it("a failing job does not stop the next one, and its row records the failure", async () => {
    const { deps, state } = await setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let ran = false;
    await runJobs(deps, [job("bad", async () => { throw new Error("boom"); }), job("good", async () => void (ran = true))], LIMITS);
    expect(ran).toBe(true);
    expect(await state("bad")).toMatchObject({ failures: 1, last_error: "job_failed", last_ok_at: null });
    expect(log).toHaveBeenCalled();
  });

  it("never stores or logs an error message, which may quote a secret or a payload", async () => {
    const { deps, state } = await setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runJobs(deps, [job("bad", async () => { throw new Error("token=hunter2 body={...}"); })], LIMITS);
    expect((await state("bad"))?.last_error).toBe("job_failed");
    expect(JSON.stringify(log.mock.calls)).not.toContain("hunter2");
  });

  it("keeps a stable snake_case error code", async () => {
    const { deps, state } = await setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runJobs(deps, [job("bad", async () => { throw Object.assign(new Error("x"), { code: "runtime_unavailable" }); })], LIMITS);
    expect((await state("bad"))?.last_error).toBe("runtime_unavailable");
  });

  it("clears the failure once the job succeeds again", async () => {
    const { deps, state, clock } = await setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let fail = true;
    const jobs = [job("a", async () => { if (fail) throw new Error("x"); })];
    await runJobs(deps, jobs, LIMITS);
    fail = false;
    clock.t += MIN;
    await runJobs(deps, jobs, LIMITS);
    expect(await state("a")).toMatchObject({ failures: 0, last_error: null, last_ok_at: clock.t });
  });

  it("backs repeated failures off, capped at the job's own interval", async () => {
    const { deps, state, clock } = await setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const jobs = [job("a", async () => { throw new Error("x"); })];
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      await runJobs(deps, jobs, LIMITS);
      const next = (await state("a"))?.next_at ?? 0;
      delays.push(next - clock.t);
      clock.t = next;
    }
    expect(delays).toEqual([0, MIN, 2 * MIN, 4 * MIN, 5 * MIN, 5 * MIN]);
  });
});

describe("runJobs cursor", () => {
  it("hands the stored cursor back and reruns next tick while the job has more to do", async () => {
    const { deps, state, clock } = await setup();
    const seen: (string | null)[] = [];
    const jobs = [job("a", async (c) => {
      seen.push(c.cursor);
      return c.cursor === null ? { cursor: "page2" } : undefined;
    })];
    await runJobs(deps, jobs, LIMITS);
    expect(await state("a")).toMatchObject({ cursor: "page2", next_at: clock.t, failures: 0 });
    clock.t += MIN;
    await runJobs(deps, jobs, LIMITS);
    expect(seen).toEqual([null, "page2"]);
    expect(await state("a")).toMatchObject({ cursor: null, next_at: clock.t + 5 * MIN });
  });

  it("keeps the cursor when the job fails", async () => {
    const { deps, db, state } = await setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await db.run("INSERT INTO job_state (name, next_at, cursor) VALUES ('a', 0, 'c1')");
    await runJobs(deps, [job("a", async () => { throw new Error("x"); })], LIMITS);
    expect((await state("a"))?.cursor).toBe("c1");
  });
});

describe("runJobs fetch budget", () => {
  it("counts deps.fetch: the call past the budget fails budget_exhausted and later jobs wait", async () => {
    const { deps, state, fetches, clock } = await setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let second = false;
    const report = await runJobs(deps, [
      job("a", async (c) => {
        for (let i = 0; i < 5; i++) await c.deps.fetch("https://x.test/");
      }),
      job("b", async () => void (second = true)),
    ], { wallMs: 20_000, fetches: 3 });
    expect(fetches).toHaveLength(3);
    expect(second).toBe(false);
    expect(report).toMatchObject({ ran: ["a"], stopped: "budget_exhausted" });
    expect(await state("a")).toMatchObject({ last_error: "budget_exhausted", failures: 1, next_at: clock.t });
    expect(await state("b")).toBeNull();
  });

  it("keeps the last checkpoint on budget_exhausted, and the next tick resumes from it", async () => {
    const { deps, state, clock } = await setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seen: (string | null)[] = [];
    const jobs = [job("a", async (c) => {
      seen.push(c.cursor);
      let i = Number(c.cursor ?? 0);
      while (i < 5) {
        await c.deps.fetch("https://x.test/");
        i++;
        await c.checkpoint(String(i));
      }
    })];
    await runJobs(deps, jobs, { wallMs: 20_000, fetches: 3 });
    expect((await state("a"))?.cursor).toBe("3");
    clock.t += MIN;
    await runJobs(deps, jobs, { wallMs: 20_000, fetches: 3 });
    expect(seen).toEqual([null, "3"]);
    expect(await state("a")).toMatchObject({ cursor: null, failures: 0 });
  });

  it("a job that swallows the budget error still fails budget_exhausted", async () => {
    const { deps, state } = await setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runJobs(deps, [job("a", async (c) => {
      await c.deps.fetch("https://x.test/").catch(() => undefined);
      await c.deps.fetch("https://x.test/").catch(() => undefined);
    })], { wallMs: 20_000, fetches: 1 });
    expect((await state("a"))?.last_error).toBe("budget_exhausted");
  });

  it("spending exactly the budget succeeds, but no further job starts", async () => {
    const { deps, state } = await setup();
    let second = false;
    const report = await runJobs(deps, [
      job("a", async (c) => void (await c.deps.fetch("https://x.test/"))),
      job("b", async () => void (second = true)),
    ], { wallMs: 20_000, fetches: 1 });
    expect((await state("a"))?.failures).toBe(0);
    expect(second).toBe(false);
    expect(report.stopped).toBe("budget_exhausted");
  });

  it("shares one budget across rtctl.op, rtctl.tenant and fetch", async () => {
    const calls: string[] = [];
    const res = { status: 200, headers: {}, body: null };
    const rtctl: RtCtl = {
      op: async () => (calls.push("op"), res),
      tenant: async () => (calls.push("tenant"), res),
    };
    const { deps, state, fetches } = await setup({ rtctl });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runJobs(deps, [job("a", async (c) => {
      await c.deps.rtctl?.op({ method: "GET", path: "/v1/x" });
      await c.deps.rtctl?.tenant("k", { method: "GET", path: "/v1/x" });
      await c.deps.fetch("https://x.test/");
      await c.deps.rtctl?.op({ method: "GET", path: "/v1/x" });
    })], { wallMs: 20_000, fetches: 3 });
    expect(calls).toEqual(["op", "tenant"]);
    expect(fetches).toHaveLength(1);
    expect((await state("a"))?.last_error).toBe("budget_exhausted");
  });

  it("a job that always exhausts the budget does not starve the jobs after it", async () => {
    const { deps, clock, state } = await setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let starved = 0;
    const jobs = [
      job("hog", async (c) => { for (;;) await c.deps.fetch("https://x.test/"); }),
      job("later", async () => void starved++),
    ];
    for (let i = 0; i < 4; i++) {
      await runJobs(deps, jobs, { wallMs: 20_000, fetches: 2 });
      clock.t += MIN;
    }
    expect(starved).toBeGreaterThan(0);
    expect((await state("hog"))?.last_error).toBe("budget_exhausted");
  });

  it("exposes the budget error as a typed error to the job", async () => {
    const { deps } = await setup();
    let err: unknown;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runJobs(deps, [job("a", async (c) => {
      await c.deps.fetch("https://x.test/").catch((e: unknown) => { err = e; });
    })], { wallMs: 20_000, fetches: 0 });
    expect(err).toBeInstanceOf(BudgetExhausted);
  });
});

describe("runJobs wall budget", () => {
  it("a job past the wall fails budget_exhausted on its next call and the next job never starts", async () => {
    const { deps, clock, state, fetches } = await setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let second = false;
    const report = await runJobs(deps, [
      job("slow", async (c) => {
        clock.t += 21_000;
        await c.deps.fetch("https://x.test/");
      }),
      job("b", async () => void (second = true)),
    ], LIMITS);
    expect(fetches).toHaveLength(0);
    expect(second).toBe(false);
    expect(report.stopped).toBe("budget_exhausted");
    expect((await state("slow"))?.last_error).toBe("budget_exhausted");
  });

  it("stops between jobs once the wall is spent, without marking the finished job failed", async () => {
    const { deps, clock, state } = await setup();
    let second = false;
    await runJobs(deps, [
      job("slow", async () => { clock.t += 20_000; }),
      job("b", async () => void (second = true)),
    ], LIMITS);
    expect(second).toBe(false);
    expect((await state("slow"))?.failures).toBe(0);
  });

  it("abandons a job that hangs without making a call, and refuses its late calls", async () => {
    const { deps, state, fetches } = await setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let late: unknown;
    let finished: Promise<unknown> = Promise.resolve();
    const report = await runJobs(deps, [job("hang", (c) => {
      finished = gate.then(() => c.deps.fetch("https://x.test/")).catch((e: unknown) => { late = e; });
      return new Promise(() => undefined);
    })], { wallMs: 5, fetches: 30 });
    expect(report.stopped).toBe("budget_exhausted");
    expect((await state("hang"))?.last_error).toBe("budget_exhausted");
    release();
    await finished;
    expect(late).toBeInstanceOf(BudgetExhausted);
    expect(fetches).toHaveLength(0);
  });
});

describe("runJobs fetch timeout", () => {
  it("gives every fetch a timeout signal of its own, also keeping the caller's signal", async () => {
    const { deps, fetches } = await setup();
    const mine = new AbortController();
    await runJobs(deps, [job("a", async (c) => {
      await c.deps.fetch("https://x.test/");
      await c.deps.fetch("https://x.test/", { signal: mine.signal });
    })], LIMITS);
    expect(fetches[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetches[1]?.signal?.aborted).toBe(false);
    mine.abort();
    expect(fetches[1]?.signal?.aborted).toBe(true);
  });

  it("a fetch that never answers is aborted at the timeout", async () => {
    const hang: typeof fetch = (_u, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error)));
    const { deps, state } = await setup({ fetch: hang });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runJobs(deps, [job("a", async (c) => void (await c.deps.fetch("https://slow.test/")))], { wallMs: 20_000, fetches: 30, fetchTimeoutMs: 5 });
    expect(await state("a")).toMatchObject({ failures: 1, last_error: "job_failed" });
  });

  it("caps the runtime client deadline at the fetch timeout", async () => {
    const res = { status: 200, headers: {}, body: null };
    const { deps } = await setup({ rtctl: { op: async () => res, tenant: async () => res, timeoutMs: 10_000 } });
    let seen: number | undefined;
    await runJobs(deps, [job("a", async (c) => { seen = c.deps.rtctl?.timeoutMs; })], { wallMs: 20_000, fetches: 30, fetchTimeoutMs: 3_000 });
    expect(seen).toBe(3_000);
  });

  it("leaves rtctl unset when the deployment has none", async () => {
    const { deps } = await setup();
    let seen: unknown = "unset";
    await runJobs(deps, [job("a", async (c) => { seen = c.deps.rtctl; })], LIMITS);
    expect(seen).toBeUndefined();
  });
});
