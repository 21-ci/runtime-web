import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw";
import { TelemetryNotice } from "./telemetry-notice";
import { UpdateNotice, UpdatesSection } from "./update-notice";

const outdated = {
  enabled: true,
  checked_at: 1_700_000_000_000,
  items: [
    {
      component: "runtime_web",
      repo: "21-ci/runtime-web",
      current: "0.1.0",
      latest: "0.2.0",
      outdated: true,
      check_failed: false,
      notes_url: "https://github.com/21-ci/runtime-web/releases/tag/v0.2.0",
      commands: { bare: "sudo sh install.sh --version 0.2.0", docker: "sudo sh install.sh --mode docker --version 0.2.0" },
    },
    {
      component: "runtime",
      repo: "21-ci/runtime",
      current: "0.9.0",
      latest: "0.9.0",
      outdated: false,
      check_failed: false,
      notes_url: "https://github.com/21-ci/runtime/releases/tag/v0.9.0",
      commands: { bare: "cosign verify-blob", docker: null },
    },
  ],
};

const signedIn = (admin: boolean) =>
  http.get("/api/me", () => HttpResponse.json({ user: { instance_admin: admin } }));

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("TelemetryNotice", () => {
  it.each([
    [true, "Sending"],
    [false, "Off"],
    [null, "Not reported by the node yet"],
  ])("shows the node's state: %s", async (sending, label) => {
    server.use(http.get("/api/admin/telemetry", () => HttpResponse.json({ sending })));
    wrap(<TelemetryNotice />);
    expect(await screen.findByText(label)).toBeInTheDocument();
  });
});

describe("UpdateNotice", () => {
  it("shows an admin what is outdated, with notes and commands", async () => {
    server.use(signedIn(true), http.get("/api/admin/updates", () => HttpResponse.json(outdated)));
    wrap(<UpdateNotice />);
    await userEvent.click(await screen.findByRole("button", { name: /update available/i }));

    expect(await screen.findByText("0.1.0 → 0.2.0")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /release notes/i })).toHaveAttribute("href", outdated.items[0]?.notes_url);
    expect(screen.getByText(/--mode docker --version 0.2.0/)).toBeInTheDocument();
    expect(screen.queryByText(/cosign verify-blob/)).not.toBeInTheDocument();
  });

  it("stays out of the way when nothing is outdated", async () => {
    let asked = false;
    server.use(
      signedIn(true),
      http.get("/api/admin/updates", () => {
        asked = true;
        return HttpResponse.json({ enabled: true, checked_at: null, items: [] });
      }),
    );
    wrap(<UpdateNotice />);
    await waitFor(() => expect(asked).toBe(true));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("never asks for a member who is not an instance admin", async () => {
    let asked = false;
    server.use(
      signedIn(false),
      http.get("/api/admin/updates", () => {
        asked = true;
        return HttpResponse.json(outdated);
      }),
    );
    wrap(<UpdateNotice />);
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toBe(false);
  });
});

describe("UpdatesSection", () => {
  const failing = {
    enabled: true,
    checked_at: 1_700_000_000_000,
    items: [{ ...outdated.items[1], outdated: false, check_failed: true, check_error: "http_403" }],
  };

  it("says why the check failed and checks again on request", async () => {
    let checks = 0;
    server.use(
      signedIn(true),
      http.get("/api/admin/updates", () => HttpResponse.json(failing)),
      http.post("/api/admin/updates/check", () => {
        checks++;
        return HttpResponse.json({ ...failing, items: [{ ...failing.items[0], check_failed: false, check_error: null }] });
      }),
    );
    wrap(<UpdatesSection />);
    expect(await screen.findByText(/rate limit/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(checks).toBe(1));
    await waitFor(() => expect(screen.queryByText(/rate limit/i)).toBeNull());
  });

  it("keeps a failing check out of the sidebar; the settings page reports it", async () => {
    server.use(signedIn(true), http.get("/api/admin/updates", () => HttpResponse.json(failing)));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <QueryClientProvider client={client}>
            <UpdateNotice />
          </QueryClientProvider>
        ),
      }),
    });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(client.getQueryData(["admin", "updates"])).toBeTruthy());
    expect(screen.queryByText(/update check/i)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("turns the check off", async () => {
    let sent: unknown;
    server.use(
      signedIn(true),
      http.get("/api/admin/updates", () => HttpResponse.json(outdated)),
      http.put("/api/admin/updates", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ ...outdated, enabled: false });
      }),
    );
    wrap(<UpdatesSection />);
    const toggle = await screen.findByRole("switch", { name: /check for new releases/i });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(sent).toEqual({ enabled: false }));
    await waitFor(() => expect(toggle).not.toBeChecked());
  });
});
