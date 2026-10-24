import { http, HttpResponse } from "msw";

import { server } from "@/test/msw";
import { apps } from "@/test/shell-fixtures";

// appView is the AppView body (docs/reference/api.md §8.1) for the "hello" app in the shell fixtures.
export const appView = {
  ...apps[0],
  etag: '"etag-1"',
  runtime: "deno",
  profile: null,
  access: "key" as const,
  url: "https://runtime.example.test/s/hello/",
  scaling: null,
  ingress: { methods: ["GET"], path_prefixes: ["/api"], ip_allow: ["10.0.0.0/8"], rate_limit: null },
  egress: null,
  call: null,
  triggers: null,
  status: { ...apps[0].status, inflight: 0, admission: null },
  limits: { requested: null, effective: {}, source: "plan" as const },
};

export const schedules = [
  {
    id: "sch_1",
    kind: "cron",
    cron: "*/15 * * * *",
    every_seconds: null,
    timezone: "UTC",
    payload: {},
    enabled: true,
    next_due: 1_800_000_000_000,
  },
];

export const onceSchedules = [{ id: "sch_once_1", kind: "once", run_at: 1_800_000_000_000 }];

export const events = [
  { id: "ev_1", ts: 1_700_000_000_000, kind: "version.live", data: { version: 1 } },
  { id: "ev_2", ts: 1_700_000_100_000, kind: "build.failed", data: { reason: "syntax" } },
];

export const dlqItems = [{ id: "dlq_1", body: { job: 1 }, attempts: 3, failed_at: 1_700_000_000_000 }];

type Opts = {
  events?: typeof events;
  dlq?: typeof dlqItems;
  onRedrive?: () => void;
  onPurge?: () => void;
  onEnqueue?: (body: unknown) => void;
  effective?: Record<string, unknown>;
};

// useAppHandlers serves the app-scoped reads for the "hello" app in the "acme" org.
export function useAppHandlers(opts: Opts = {}) {
  server.use(
    http.get("/api/orgs/:org/apps/:app", () =>
      HttpResponse.json({
        ...appView,
        limits: { ...appView.limits, effective: opts.effective ?? appView.limits.effective },
      }),
    ),
    http.get("/api/orgs/:org/apps/:app/stats", () =>
      HttpResponse.json({ requests: 42, errors: 2, error_rate: 0.05, p50_ms: 12, p95_ms: 80, p99_ms: 120 }),
    ),
    http.get("/api/orgs/:org/apps/:app/events", () =>
      HttpResponse.json({ items: opts.events ?? events, next_cursor: null }),
    ),
    http.get("/api/orgs/:org/apps/:app/schedules", () => HttpResponse.json({ items: schedules })),
    http.get("/api/orgs/:org/apps/:app/schedules/once", () => HttpResponse.json({ items: onceSchedules })),
    http.get("/api/orgs/:org/apps/:app/queue", () =>
      HttpResponse.json({ depth: 3, in_flight: 1, oldest_age_ms: 500, dlq: (opts.dlq ?? dlqItems).length }),
    ),
    http.get("/api/orgs/:org/apps/:app/dlq", () => HttpResponse.json({ items: opts.dlq ?? dlqItems })),
    http.post("/api/orgs/:org/apps/:app/dlq/redrive", () => {
      opts.onRedrive?.();
      return HttpResponse.json({ redriven: 1 });
    }),
    http.delete("/api/orgs/:org/apps/:app/dlq", () => {
      opts.onPurge?.();
      return new HttpResponse(null, { status: 204 });
    }),
    http.post("/api/orgs/:org/apps/:app/queue", async ({ request }) => {
      opts.onEnqueue?.(await request.json());
      return HttpResponse.json({ id: "msg_1" }, { status: 201 });
    }),
  );
}
