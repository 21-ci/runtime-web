import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { BackupsPage } from "@/components/features/admin/backups-page";
import { LineChart } from "@/components/ui/line-chart";
import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { PlanUsagePanel } from "./plan-usage";
import { QuotaBar } from "./quota-bar";

afterEach(cleanup);

function wrap(ui: ReactNode) {
  const qc = createQueryClient();
  qc.setDefaultOptions({ queries: { retry: false } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const q = (used: number, limit: number | null, period = "total") => ({ used, limit, remaining: limit, period });

describe("plan usage", () => {
  it("shows CPU as time, says storage is not metered, counts hidden Apps and has no bar on a per-App ceiling", async () => {
    server.use(http.get("*/api/orgs/acme/plan-usage", () => HttpResponse.json({
      plan: "unlimited",
      resets_at: Date.UTC(2026, 10, 6, 0, 0),
      metrics: [
        { key: "cpu_ms", used: 10_563, limit: null, period: "day" },
        { key: "storage_bytes", used: 0, limit: 1_073_741_824, period: "total" },
        { key: "services", used: 10, limit: 100, period: "total" },
        { key: "branches", used: 1, limit: 10, period: "total" },
        { key: "secrets", used: 0, limit: 1_000_000, period: "per_service" },
      ],
    })));
    wrap(<PlanUsagePanel org="acme" />);
    expect(await screen.findByText("CPU time")).toBeTruthy();
    expect(screen.getByText(/^11 s/)).toBeTruthy();
    expect(screen.getByText(/^Not metered, limit 1/)).toBeTruthy();
    expect(screen.getByText("including 1 branch or preview")).toBeTruthy();
    expect(screen.getByText(/set by this node's administrator/)).toBeTruthy();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
    expect(screen.getByText(/Resets .*\d:\d\d|Resets .*\d\d:\d\d/)).toBeTruthy();
  });
});

describe("quota bar", () => {
  it("says the same about Apps and storage", async () => {
    server.use(http.get("*/api/orgs/acme/limits", () => HttpResponse.json({
      day: "2026-11-05", resets_at: Date.UTC(2026, 10, 6), invocations: q(1, 10, "day"), egress_bytes: q(0, 10, "day"), storage_bytes: q(0, 2048), services: q(10, 20), schedules: q(0, 5, "per_service"), allowed_triggers: null, hidden_services: 2,
    })));
    wrap(<QuotaBar org="acme" />);
    expect(await screen.findByText("including 2 branches and previews")).toBeTruthy();
    expect(screen.getByText(/^Not metered, limit/)).toBeTruthy();
  });
});

describe("disk chart", () => {
  it("tops its axis at the disk's size, not a rounded guess", () => {
    const labels = { noData: "", table: "t", time: "t", value: "v" };
    const { container } = render(<LineChart title="Disk" labels={labels} max={224} points={[{ ts: 1, value: 188 }, { ts: 2, value: 188 }]} />);
    expect(container.querySelector("figure .absolute.top-0")?.textContent).toBe("224");
  });
});

describe("backups page", () => {
  it("explains the disabled button, titles the sample as a sample and tells how to restore", async () => {
    server.use(
      http.get("*/api/admin/backups/status", () => HttpResponse.json({ enabled: false, schedule: "", last_ok_at: null, last_failure: null, next_at: null, running_id: null, destination: null })),
      http.get("*/api/admin/backups", () => HttpResponse.json({ items: [] })),
    );
    wrap(<BackupsPage />);
    expect(await screen.findByText(/needs backups to be enabled/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back up now" }).getAttribute("title")).toMatch(/enabled/);
    expect(screen.getByText("To enable, add this to rt.toml")).toBeTruthy();
    expect(screen.getByText(/rt backup restore/)).toBeTruthy();
  });
});
