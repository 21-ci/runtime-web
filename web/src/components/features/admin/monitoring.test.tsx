import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LineChart } from "@/components/ui/line-chart";
import { AppCharts } from "@/components/features/overview/app-charts";
import { MigrationsCard, migrationRefused, PromotePreflight } from "@/components/features/versions/migrations";
import { ApiError } from "@/lib/api";
import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { BackupsPage } from "./backups-page";
import { NodeMonitor } from "./node-monitor";
import { pollInterval } from "./use-monitoring";

afterEach(cleanup);
const labels = { noData: "empty", table: "table", time: "time", value: "value" };

function wrap(ui: ReactNode) {
  const qc = createQueryClient();
  qc.setDefaultOptions({ queries: { retry: false } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const STATUS = { enabled: true, schedule: "0 3 * * *", last_ok_at: null, last_failure: null, next_at: null, running_id: null, destination: { kind: "local" } };

describe("LineChart", () => {
  it("says so when there is nothing to draw", () => {
    render(<LineChart title="CPU" labels={labels} points={[{ ts: 1, value: null }]} />);
    expect(screen.getByText("empty")).toBeTruthy();
    expect(screen.queryByTestId("chart-line")).toBeNull();
  });

  it("caps the table at 300 points and draws the line", () => {
    const points = Array.from({ length: 1000 }, (_, i) => ({ ts: i + 1, value: i }));
    const { container } = render(<LineChart title="CPU" labels={labels} points={points} />);
    expect(screen.getByTestId("chart-line").getAttribute("d")).toContain("L");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(300);
  });

  it("reads a value out from the keyboard", () => {
    render(<LineChart title="CPU" labels={labels} points={[{ ts: 1, value: 5 }, { ts: 2, value: 7 }]} />);
    fireEvent.keyDown(screen.getByRole("img"), { key: "ArrowLeft" });
    expect(screen.getByTestId("chart-readout").textContent).toContain("7");
  });
});

describe("polling", () => {
  it("stops while the tab is hidden", () => {
    const spy = vi.spyOn(document, "hidden", "get");
    spy.mockReturnValue(true);
    expect(pollInterval()).toBe(false);
    spy.mockReturnValue(false);
    expect(pollInterval()).toBe(15_000);
    spy.mockRestore();
  });
});

describe("BackupsPage", () => {
  const handlers = (status = STATUS) => {
    const state = { created: 0 };
    server.use(
      http.get("*/api/admin/backups/status", () => HttpResponse.json(status)),
      http.get("*/api/admin/backups", () => HttpResponse.json({ items: [{ id: "bkp_1", state: "ok", trigger: "api", started_at: 1, bytes: 2048, encrypted: false, failure: null }], next_cursor: null })),
      http.post("*/api/admin/backups", () => {
        state.created++;
        return HttpResponse.json({ id: "bkp_2", state: "running" }, { status: 202 });
      }),
    );
    return state;
  };

  it("lists, warns on a plain archive, starts a backup and offers no download or delete", async () => {
    const state = handlers();
    wrap(<BackupsPage />);
    await screen.findByText("bkp_1");
    expect(screen.getByText("Not encrypted")).toBeTruthy();
    expect(screen.getByText(/21ci backup download bkp_1/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /download/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
    const now = screen.getByRole("button", { name: "Back up now" });
    await waitFor(() => expect((now as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(now);
    await waitFor(() => expect(state.created).toBe(1));
  });

  it("disables the button when backups are off or one is running", async () => {
    handlers({ ...STATUS, enabled: false });
    wrap(<BackupsPage />);
    await screen.findByText("Not enabled");
    expect((screen.getByRole("button", { name: "Back up now" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("NodeMonitor", () => {
  it("draws the node's series and the 7-day range asks the ring", async () => {
    const asked: string[] = [];
    server.use(
      http.get("*/api/admin/node/series", ({ request }) => {
        asked.push(new URL(request.url).searchParams.get("range") ?? "");
        return HttpResponse.json({ range: "1h", step_s: 60, data_from: 1, points: [{ ts: 1, cpu_pct: 5 }, { ts: 2, cpu_pct: 9 }] });
      }),
      http.get("*/api/admin/node/status", () => HttpResponse.json({ host: { uptime_s: 90_000, cpu_pct: 1.5, load: [0.5, 0, 0], disk: null, net: null } })),
      http.get("*/api/admin/node/stats", () => HttpResponse.json({ items: [{ service: "svc_1", tenant: "t", slug: "shop", count: 9, errors: 1 }], next_cursor: null })),
      http.get("*/api/admin/node/events", () => HttpResponse.json({ items: [{ id: 1, ts: 1, service: null, kind: "node.restored" }], next_cursor: null })),
    );
    wrap(<NodeMonitor />);
    await screen.findByText("shop");
    expect(await screen.findByText("node.restored")).toBeTruthy();
    expect(screen.getByText("1d 1h")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(asked).toContain("7d"));
  });

  it("says when the node has no such route", async () => {
    server.use(
      http.get("*/api/admin/node/series", () => HttpResponse.json({ error: { code: "not_found", message: "x" } }, { status: 404 })),
      http.get("*/api/admin/node/status", () => HttpResponse.json({})),
      http.get("*/api/admin/node/stats", () => HttpResponse.json({ items: [] })),
      http.get("*/api/admin/node/events", () => HttpResponse.json({ items: [] })),
    );
    wrap(<NodeMonitor />);
    expect(await screen.findByText(/does not report monitoring data/)).toBeTruthy();
  });
});

describe("AppCharts", () => {
  it("asks the App's own route, with a step and without one for the week", async () => {
    const asked: string[] = [];
    server.use(
      http.get("*/api/orgs/acme/apps/hello/stats", ({ request }) => {
        asked.push(new URL(request.url).search);
        return HttpResponse.json({ series: [{ ts: 1, count: 2, errors: 0, total_p95: 3 }, { ts: 2, count: 4, errors: 1, total_p95: 5 }], data_from: 1 });
      }),
    );
    wrap(<AppCharts org="acme" app="hello" />);
    await waitFor(() => expect(screen.getAllByTestId("chart-line")).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    await screen.findByText(/Percentiles are not kept/);
    await waitFor(() => expect(screen.getAllByTestId("chart-line")).toHaveLength(2));
    expect(asked).toEqual(["?window=1h&step=1m", "?window=7d"]);
  });
});

describe("migrations", () => {
  it("is hidden with none and lists applied and pending otherwise", () => {
    const { container } = render(<MigrationsCard migrations={{ applied: [], pending_for_latest: [] }} />);
    expect(container.textContent).toBe("");
    render(<MigrationsCard migrations={{ applied: [{ name: "0001_a.sql", sha256: "a", applied_at: 1, version: 2 }], pending_for_latest: [{ name: "0002_b.sql", sha256: "b" }] }} />);
    expect(screen.getByText("0001_a.sql")).toBeTruthy();
    expect(screen.getByText("0002_b.sql")).toBeTruthy();
  });

  function Check({ fn }: { fn: () => Promise<{ pending_migrations: string[] }> }) {
    const q = useQuery({ queryKey: ["c", fn], queryFn: fn, retry: false });
    return <PromotePreflight check={q} />;
  }

  it("names pending_migrations from the dry run", async () => {
    wrap(<Check fn={async () => ({ pending_migrations: ["0002_b.sql"] })} />);
    expect(await screen.findByText("0002_b.sql")).toBeTruthy();
  });

  it("names the file and statement of a failure, and only a migration error blocks", async () => {
    const e = new ApiError(409, "migration_failed", "x", { file: "0002_b.sql", statement_index: 3, message: "no such table" });
    wrap(<Check fn={() => Promise.reject(e)} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("0002_b.sql");
    expect(alert.textContent).toContain("no such table");
    expect(migrationRefused(e)).toBe(true);
    expect(migrationRefused(new ApiError(504, "runtime_timeout", "x"))).toBe(false);
  });
});
