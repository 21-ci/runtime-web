import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { AnalyticsView } from "./analytics-page";
import { BranchCompare } from "./branch-compare";
import { compareProportions, hourGrid, outcomeSegments, topSegments } from "./analytics-lib";
import { MetricPlane } from "./metric-plane";

afterEach(cleanup);

function wrap(ui: ReactNode) {
  const qc = createQueryClient();
  qc.setDefaultOptions({ queries: { retry: false } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("analytics-lib", () => {

  it("orders outcomes by count and greens only ok", () => {
    const s = outcomeSegments({ ok: 5, guest_error: 9, cpu_limit: 0 });
    expect(s.map((x) => x.key)).toEqual(["guest_error", "ok"]);
    expect(s[1]?.color).toContain("green");
  });

  it("folds the tail of a top list into other, keeping every request", () => {
    const s = topSegments(Array.from({ length: 8 }, (_, i) => ({ key: `a${i}`, label: `a${i}`, value: 8 - i })), 5, "Other");
    expect(s).toHaveLength(6);
    expect(s[5]?.label).toBe("Other");
    expect(s.reduce((n, x) => n + x.value, 0)).toBe(36);
  });

  it("sums points into their local weekday and hour", () => {
    const at = new Date(2026, 10, 2, 13, 30).getTime();
    const grid = hourGrid([{ ts: at, count: 2 }, { ts: at, count: 3 }]);
    expect(grid[new Date(at).getDay()]?.[13]).toBe(5);
  });

  it("calls a difference real only when the interval leaves zero", () => {
    expect(compareProportions({ errors: 500, count: 1000 }, { errors: 100, count: 1000 }).significant).toBe(true);
    expect(compareProportions({ errors: 10, count: 1000 }, { errors: 11, count: 1000 }).significant).toBe(false);
  });
});

describe("MetricPlane", () => {
  it("charts the metric picked from the list", () => {
    const labels = { noData: "empty", table: "table", time: "time", value: "value" };
    render(
      <MetricPlane
        label="Metrics"
        labels={labels}
        metrics={[
          { key: "a", label: "Alpha", value: "1", points: [{ ts: 1, value: 1 }, { ts: 2, value: 2 }] },
          { key: "b", label: "Beta", value: "2", points: [] },
        ]}
      />,
    );
    expect(screen.getAllByTestId("chart-line")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
    expect(screen.getByRole("button", { name: /Beta/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("No data")).toBeTruthy();
  });
});

const stats = (over: object = {}) => ({
  count: 100,
  errors: 2,
  error_rate: 0.02,
  outcomes: { ok: 98, guest_error: 2 },
  total: { p50_ms: 10, p95_ms: 40, p99_ms: 90 },
  queue: { p50_ms: 1, p95_ms: 2, p99_ms: 3 },
  init: { p50_ms: 0, p95_ms: 0, p99_ms: 0 },
  exec: { p50_ms: 9, p95_ms: 38, p99_ms: 85 },
  ...over,
});

describe("AnalyticsView", () => {
  const routes = (statsBody: object) =>
    server.use(
      http.get("*/api/orgs/acme/apps/hello/stats", () => HttpResponse.json(statsBody)),
      http.get("*/api/orgs/acme/apps/hello/branches", () => HttpResponse.json({ items: [] })),
    );

  it("draws what the runtime returns and leaves out what it does not record", async () => {
    routes(stats());
    wrap(<AnalyticsView org="acme" app="hello" />);
    expect(await screen.findByText("98%")).toBeTruthy();
    expect(screen.getByText("Guest error")).toBeTruthy();
    expect(screen.queryByText("Request sources")).toBeNull();
    expect(screen.queryByText("Code updates")).toBeNull();
    expect(screen.getByText(/HTTP status codes are not recorded/)).toBeTruthy();
  });

  it("says so when an App has had no traffic", async () => {
    routes({});
    wrap(<AnalyticsView org="acme" app="hello" />);
    expect((await screen.findAllByText("No traffic in this range.")).length).toBeGreaterThan(0);
    // No series came back, so no total can be claimed.
    expect(screen.getAllByRole("button", { name: /Requests/ })[0]?.textContent).toContain("N/A");
  });

  it("exports the shown range through the server route", async () => {
    routes(stats());
    wrap(<AnalyticsView org="acme" app="hello" />);
    const traffic = await screen.findByRole("region", { name: "Traffic" });
    const link = within(traffic).getByRole("link", { name: "Export" });
    expect(link.getAttribute("href")).toBe("/api/orgs/acme/apps/hello/stats?format=csv&window=1h&step=1m");
    fireEvent.click(within(traffic).getByRole("radio", { name: "24 hours" }));
    expect(within(traffic).getByRole("link", { name: "Export" }).getAttribute("href")).toBe("/api/orgs/acme/apps/hello/stats?format=csv&window=24h&step=5m");
  });

  it("offers requests by hour as a table with only the hours that had requests", async () => {
    const ts = new Date(2026, 10, 2, 13, 0).getTime();
    routes({ ...stats(), series: [{ ts, count: 7, errors: 0 }, { ts: ts + 3_600_000, count: 0, errors: 0 }] });
    wrap(<AnalyticsView org="acme" app="hello" />);
    const card = await screen.findByRole("region", { name: "Requests by hour" });
    const table = await within(card).findByRole("table", { hidden: true });
    expect(within(table).getAllByRole("row", { hidden: true })).toHaveLength(2);
    expect(within(table).getByText("13:00")).toBeTruthy();
  });

  it("leaves a phase out when the runtime gave no percentiles for it", async () => {
    routes(stats({ queue: undefined }));
    wrap(<AnalyticsView org="acme" app="hello" />);
    await screen.findByText("98%");
    expect(screen.getByText("Run")).toBeTruthy();
    expect(screen.queryByText("Queue")).toBeNull();
  });
});

describe("BranchCompare", () => {
  const branch = { name: "next", slug: "hello--next", url: "u", build_state: "ready", live_version: 2, digest: null, expires_at: null };

  it("is absent without a live branch", async () => {
    server.use(http.get("*/api/orgs/acme/apps/hello/branches", () => HttpResponse.json({ items: [{ ...branch, live_version: null }] })));
    const { container } = wrap(<BranchCompare org="acme" app="hello" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
  });

  it("compares the App with its branch on real figures", async () => {
    server.use(
      http.get("*/api/orgs/acme/apps/hello/branches", () => HttpResponse.json({ items: [branch] })),
      http.get("*/api/orgs/acme/apps/hello/stats", () => HttpResponse.json(stats({ count: 1000, errors: 100 }))),
      http.get("*/api/orgs/acme/apps/hello--next/stats", () => HttpResponse.json(stats({ count: 1000, errors: 10 }))),
    );
    wrap(<BranchCompare org="acme" app="hello" />);
    expect(await screen.findByText(/very likely fewer errors/)).toBeTruthy();
    expect(screen.getByText("10.00%")).toBeTruthy();
    expect(screen.getByText("1.00%")).toBeTruthy();
  });

  it("will not judge a branch with too little traffic", async () => {
    server.use(
      http.get("*/api/orgs/acme/apps/hello/branches", () => HttpResponse.json({ items: [branch] })),
      http.get("*/api/orgs/acme/apps/hello/stats", () => HttpResponse.json(stats())),
      http.get("*/api/orgs/acme/apps/hello--next/stats", () => HttpResponse.json(stats({ count: 3, errors: 0 }))),
    );
    wrap(<BranchCompare org="acme" app="hello" />);
    expect(await screen.findByText(/Too little traffic/)).toBeTruthy();
  });

  it("does not draw a latency no side reported", async () => {
    server.use(
      http.get("*/api/orgs/acme/apps/hello/branches", () => HttpResponse.json({ items: [branch] })),
      http.get("*/api/orgs/acme/apps/hello/stats", () => HttpResponse.json(stats({ p50_ms: 10, p95_ms: 40, p99_ms: 90 }))),
      http.get("*/api/orgs/acme/apps/hello--next/stats", () => HttpResponse.json(stats({ p50_ms: 11 }))),
    );
    wrap(<BranchCompare org="acme" app="hello" />);
    expect(await screen.findByText("p50")).toBeTruthy();
    expect(screen.queryByText("p95")).toBeNull();
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
  });
});
