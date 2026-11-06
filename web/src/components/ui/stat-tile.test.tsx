import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { AppCharts } from "@/components/features/overview/app-charts";
import { QuotaBar } from "@/components/features/org/quota-bar";
import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";
import { limitsFixture } from "@/test/shell-fixtures";

import { Sparkline, StatTile } from "./stat-tile";

const withQuery = (ui: React.ReactNode) => render(<QueryClientProvider client={createQueryClient()}>{ui}</QueryClientProvider>);

describe("stat tiles", () => {
  afterEach(() => cleanup());

  it("draws a sparkline only with two known values, skipping gaps", () => {
    const { container, rerender } = render(<Sparkline values={[1, null]} />);
    expect(container.querySelector("path")).toBeNull();
    rerender(<Sparkline values={[1, null, 3]} />);
    expect(container.querySelector("path")?.getAttribute("d")?.match(/[ML]/g)).toHaveLength(2);
  });

  it("shows label, value and hint", () => {
    render(<dl><StatTile label="Free disk" value="1 GB" hint="85% used" tone="warning" /></dl>);
    expect(screen.getByText("1 GB")).toHaveClass("text-tag-orange-text");
    expect(screen.getByText("85% used")).toBeInTheDocument();
  });

  it("totals an App's traffic above its charts", async () => {
    server.use(
      http.get("/api/orgs/:org/apps/:app/stats", () =>
        HttpResponse.json({ series: [{ ts: 1, count: 90, errors: 9, total_p95: 40 }, { ts: 2, count: 10, errors: 1, total_p95: 70 }] }),
      ),
    );
    withQuery(<AppCharts org="acme" app="hello" />);
    expect(await screen.findByRole("button", { name: /Requests\s*100/ })).toBeInTheDocument();
    expect(screen.getByText("10.0%")).toHaveClass("text-danger-text");
    expect(screen.getByRole("button", { name: /p95, ms\s*70/ })).toBeInTheDocument();
  });

  it("flags quotas near their limit, and says so when none are", async () => {
    server.use(http.get("/api/orgs/:org/limits", () => HttpResponse.json(limitsFixture)));
    withQuery(<QuotaBar org="acme" />);
    expect(await screen.findByText("Within limits")).toBeInTheDocument();
    cleanup();
    server.use(
      http.get("/api/orgs/:org/limits", () =>
        HttpResponse.json({ ...limitsFixture, invocations: { limit: 1000, used: 800, remaining: 200, period: "day" } }),
      ),
    );
    withQuery(<QuotaBar org="acme" />);
    expect(await screen.findByText("Near the limit: 1")).toBeInTheDocument();
  });
});
