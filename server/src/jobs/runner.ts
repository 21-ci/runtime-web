// Runs background jobs inside one cron tick. Jobs run in the given order, so anything that sends to a
// third party goes last and a slow receiver cannot use up the tick. All outbound calls share one budget.

import type { Deps } from "../app.ts";
import type { RtCtl } from "../runtime/types.ts";
import type { Db, SqlArg } from "../storage/types.ts";
import { BudgetExhausted } from "./budget.ts";

export type RunnerDeps = Pick<Deps, "storage" | "now" | "config" | "rtctl" | "txt" | "fetch">;

export interface JobCtx {
  /** Same deps, with fetch and rtctl counted against the tick's budget. */
  deps: RunnerDeps & { fetch: typeof fetch };
  cursor: string | null;
  /** Persists progress now, so a job cut off later resumes from here. */
  checkpoint(cursor: string): Promise<void>;
}

export interface Job {
  name: string;
  everyMs: number;
  /** A returned cursor means there is more to do: the job is due again next tick. */
  run(ctx: JobCtx): Promise<{ cursor: string } | undefined>;
}

export interface Limits {
  wallMs: number;
  fetches: number;
  fetchTimeoutMs?: number;
}

export interface RunReport {
  ran: string[];
  stopped?: "budget_exhausted";
}

export const TICK_LIMITS: Required<Limits> = { wallMs: 20_000, fetches: 30, fetchTimeoutMs: 3_000 };

const RETRY_BASE_MS = 60_000;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

interface StateRow {
  name: string;
  next_at: number;
  cursor: string | null;
  last_ok_at: number | null;
  failures: number;
  [k: string]: unknown;
}

class Budget {
  private used = 0;
  private closed = false;
  /** Set once a call was refused, even if the job swallowed the error. */
  refused = false;

  constructor(
    private readonly now: () => number,
    private readonly deadline: number,
    private readonly fetches: number,
  ) {}

  spent(): boolean {
    return this.closed || this.used >= this.fetches || this.now() >= this.deadline;
  }

  close(): void {
    this.closed = true;
  }

  take(): void {
    if (this.spent()) {
      this.refused = true;
      throw new BudgetExhausted();
    }
    this.used++;
  }
}

function budgetedFetch(inner: typeof fetch, budget: Budget, timeoutMs: number): typeof fetch {
  return (input, init) => {
    try {
      budget.take();
    } catch (e) {
      return Promise.reject(e as Error);
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return inner(input, { ...init, signal });
  };
}

function budgetedRtCtl(inner: RtCtl, budget: Budget, timeoutMs: number): RtCtl {
  return {
    op: async (req) => {
      budget.take();
      return inner.op(req);
    },
    tenant: async (key, req) => {
      budget.take();
      return inner.tenant(key, req);
    },
    timeoutMs: Math.min(inner.timeoutMs ?? timeoutMs, timeoutMs),
  };
}

/** Error text can quote a secret or a guest payload, so only a stable code is stored or logged. */
function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : "job_failed";
}

/** The first retry is the next tick; after that it doubles, so a failing job yields to those after it. */
function retryDelay(failures: number, everyMs: number): number {
  return failures <= 1 ? 0 : Math.min(RETRY_BASE_MS * 2 ** (failures - 2), everyMs);
}

interface NextState {
  next_at: number;
  cursor: string | null;
  last_ok_at: number | null;
  last_error: string | null;
  failures: number;
}

async function save(db: Db, name: string, next: NextState): Promise<void> {
  const args: SqlArg[] = [name, next.next_at, next.cursor, next.last_ok_at, next.last_error, next.failures];
  await db.run(
    `INSERT INTO job_state (name, next_at, cursor, last_ok_at, last_error, failures) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET next_at = excluded.next_at, cursor = excluded.cursor,
       last_ok_at = excluded.last_ok_at, last_error = excluded.last_error, failures = excluded.failures`,
    args,
  );
}

async function nothingDue(db: Db, jobs: readonly Job[], now: number): Promise<boolean> {
  const marks = jobs.map(() => "?").join(",");
  const row = await db.first<{ c: number; m: number | null }>(
    `SELECT count(*) AS c, min(next_at) AS m FROM job_state WHERE name IN (${marks})`,
    jobs.map((j) => j.name),
  );
  return Number(row?.c ?? 0) === jobs.length && Number(row?.m ?? 0) > now;
}

/** Rejects when the wall runs out, so a job stuck on something uncounted cannot hold the tick. */
function withWall<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BudgetExhausted()), Math.max(ms, 0));
  });
  return Promise.race([p, expired]).finally(() => clearTimeout(timer));
}

export async function runJobs(deps: RunnerDeps, jobs: readonly Job[], limits: Limits = TICK_LIMITS): Promise<RunReport> {
  const report: RunReport = { ran: [] };
  if (jobs.length === 0) return report;
  const db = deps.storage.db;
  const started = deps.now();
  if (await nothingDue(db, jobs, started)) return report;

  const rows = await db.all<StateRow>("SELECT name, next_at, cursor, last_ok_at, failures FROM job_state");
  const state = new Map(rows.map((r) => [r.name, r]));
  const deadline = started + limits.wallMs;
  const budget = new Budget(deps.now, deadline, limits.fetches);
  const timeoutMs = limits.fetchTimeoutMs ?? TICK_LIMITS.fetchTimeoutMs;
  const { rtctl, ...rest } = deps;
  const counted: JobCtx["deps"] = {
    ...rest,
    fetch: budgetedFetch(deps.fetch ?? fetch, budget, timeoutMs),
    ...(rtctl ? { rtctl: budgetedRtCtl(rtctl, budget, timeoutMs) } : {}),
  };

  // A due job may legitimately have nothing to spend, so a budget of 0 still lets the first job try.
  let first = true;
  for (const job of jobs) {
    const prev = state.get(job.name);
    if (prev && prev.next_at > deps.now()) continue;
    if (!first && budget.spent()) {
      report.stopped = "budget_exhausted";
      break;
    }
    first = false;
    report.ran.push(job.name);
    let cursor = prev?.cursor ?? null;
    const ctx: JobCtx = {
      deps: counted,
      cursor,
      checkpoint: async (c) => {
        cursor = c;
        await save(db, job.name, {
          next_at: prev?.next_at ?? 0,
          cursor: c,
          last_ok_at: prev?.last_ok_at ?? null,
          last_error: null,
          failures: prev?.failures ?? 0,
        });
      },
    };
    try {
      const out = await withWall(job.run(ctx), deadline - deps.now());
      if (budget.refused) throw new BudgetExhausted();
      const now = deps.now();
      await save(db, job.name, {
        next_at: out ? now : now + job.everyMs,
        cursor: out ? out.cursor : null,
        last_ok_at: now,
        last_error: null,
        failures: 0,
      });
    } catch (e) {
      const exhausted = e instanceof BudgetExhausted || budget.refused;
      if (exhausted) budget.close();
      const code = exhausted ? "budget_exhausted" : errorCode(e);
      const failures = (prev?.failures ?? 0) + 1;
      console.error(`jobs: ${job.name} failed`, code);
      await save(db, job.name, {
        next_at: deps.now() + retryDelay(failures, job.everyMs),
        cursor,
        last_ok_at: prev?.last_ok_at ?? null,
        last_error: code,
        failures,
      });
      if (exhausted) {
        report.stopped = "budget_exhausted";
        break;
      }
    }
  }
  return report;
}
