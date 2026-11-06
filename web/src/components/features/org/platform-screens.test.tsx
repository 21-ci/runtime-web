import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { TelemetryNotice } from "@/components/features/admin/telemetry-notice";
import { SecretsPanel } from "@/components/features/secrets/secrets-panel";
import { server } from "@/test/msw";
import { PlanUsagePanel } from "./plan-usage";

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("PlanUsagePanel", () => {
  it("shows the plan and each metric against its limit, or no limit", async () => {
    server.use(
      http.get("/api/orgs/acme/plan-usage", () =>
        HttpResponse.json({
          plan: "pro",
          resets_at: 1_800_000_000_000,
          metrics: [
            { key: "invocations", used: 5, limit: 10, period: "month" },
            { key: "storage_bytes", used: 1024, limit: null, period: "total" },
          ],
        }),
      ),
    );
    wrap(<PlanUsagePanel org="acme" />);
    expect(await screen.findByText(/Plan: pro/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Invocations usage" })).toBeInTheDocument();
    expect(screen.getByText(/5 of 10 per month/)).toBeInTheDocument();
    expect(screen.getByText(/No limit/)).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
  });

  it("explains a node without the route", async () => {
    server.use(http.get("/api/orgs/acme/plan-usage", () => HttpResponse.json({ error: { code: "not_found", message: "x" } }, { status: 404 })));
    wrap(<PlanUsagePanel org="acme" />);
    expect(await screen.findByText("Usage is not available")).toBeInTheDocument();
  });
});

describe("TelemetryNotice", () => {
  it("says what is sent and links to the opt-out", () => {
    wrap(<TelemetryNotice />);
    expect(screen.getByText(/one anonymous report a day/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "How to opt out" })).toHaveAttribute("href", expect.stringContaining("#telemetry"));
  });
});

describe("Vault refs in the secrets panel", () => {
  const base = "/api/orgs/acme/apps/hello/secrets";

  it("marks a Vault secret, unlinks and syncs it", async () => {
    let unlinked = false;
    let synced = false;
    server.use(
      http.get(base, () => HttpResponse.json({ items: [{ name: "API_KEY", updated_at: 1, source: "vault", last_synced_at: 2, last_error: null }] })),
      http.delete(`${base}/API_KEY/ref`, () => ((unlinked = true), new HttpResponse(null, { status: 204 }))),
      http.post(`${base}/sync`, () => ((synced = true), HttpResponse.json({}, { status: 202 }))),
    );
    wrap(<SecretsPanel org="acme" app="hello" />);
    expect(await screen.findByText("Vault")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(synced).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Unlink API_KEY from Vault" }));
    await waitFor(() => expect(unlinked).toBe(true));
  });

  it("links with a path and field, and explains a path outside the prefix", async () => {
    let body: unknown;
    server.use(
      http.get(base, () => HttpResponse.json({ items: [] })),
      http.put(`${base}/DB/ref`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ error: { code: "ref_outside_prefix", message: "x" } }, { status: 422 });
      }),
    );
    wrap(<SecretsPanel org="acme" app="hello" />);
    await userEvent.click(await screen.findByRole("button", { name: "Link to Vault" }));
    await userEvent.type(screen.getByLabelText("Name", { selector: "input[name=ref_name]" }), "DB");
    await userEvent.type(screen.getByLabelText("Vault path"), "apps/db");
    await userEvent.type(screen.getByLabelText("Field"), "password");
    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/outside the prefix/);
    expect(body).toEqual({ path: "apps/db", field: "password" });
  });
});
