import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setCsrfToken } from "@/lib/api";
import { server } from "@/test/msw";
import { renderAt } from "@/test/render";
import { apps, useShellHandlers } from "@/test/shell-fixtures";

import { appView, useAppHandlers } from "./fixtures";

// Routes are code-split, so the first render of each test waits on a lazy chunk.
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  setCsrfToken("csrf-token-1");
});

describe("app header", () => {
  it("status pill shows last_error", async () => {
    useShellHandlers();
    useAppHandlers();
    const failed = { build_state: "failed", last_error: "boom: bad import" };
    server.use(
      http.get("/api/orgs/:org/apps", () =>
        HttpResponse.json({ items: apps.map((a) => ({ ...a, status: { ...a.status, ...failed } })), next_cursor: null }),
      ),
      http.get("/api/orgs/:org/apps/:app", () =>
        HttpResponse.json({ ...appView, status: { ...appView.status, ...failed } }),
      ),
    );
    renderAt("/acme/apps/hello");

    expect((await screen.findAllByText("Failed")).length).toBeGreaterThan(0);
    expect(screen.getByText(/boom: bad import/)).toBeInTheDocument();
  });

  it("sidebar keeps the org navigation on an app page", async () => {
    useShellHandlers();
    useAppHandlers();
    renderAt("/acme/apps/hello");
    const nav = await screen.findByRole("navigation", { name: /sidebar/i });
    expect(await within(nav).findByRole("link", { name: "Members" })).toBeInTheDocument();
    expect(await within(nav).findByRole("link", { name: "Empty" })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Logs" })).toBeNull();
  });

  it("header shows identity, access, live version and URL; tabs are in plan order", async () => {
    useShellHandlers();
    useAppHandlers();
    renderAt("/acme/apps/hello/triggers");
    await screen.findByText("API key");
    const header = screen.getByTestId("app-header");
    expect(within(header).getByText("Ready")).toBeInTheDocument();
    expect(within(header).getByRole("link", { name: "Live v1" })).toHaveAttribute("href", "/acme/apps/hello/deployments");
    expect(within(header).getAllByRole("link", { name: appView.url })[0]).toHaveAttribute("href", appView.url);
    const tabs = screen.getByRole("navigation", { name: "App sections" });
    expect(within(tabs).getAllByRole("link").map((l) => l.textContent)).toEqual([
      "Overview", "Deployments", "Logs", "Analytics", "Code", "Data", "Triggers", "Branches", "Environment", "Settings",
    ]);
  });

  it("does not wait for the apps list to frame the page", async () => {
    useShellHandlers();
    useAppHandlers();
    server.use(http.get("/api/orgs/:org/apps", () => new Promise<never>(() => {})));
    renderAt("/acme/apps/hello/triggers");
    await waitFor(() => expect(within(screen.getByTestId("app-header")).getByText("Hello")).toBeInTheDocument());
  });

  it("breadcrumb names org, project and app with their types, without the section", async () => {
    useShellHandlers();
    useAppHandlers();
    renderAt("/acme/apps/hello/triggers");
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: /Hello/ })).toBeInTheDocument());
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByText(/Project:/)).toBeInTheDocument();
    expect(within(crumbs).queryByText("Triggers")).toBeNull();
  });

  it("g then a key opens that tab, and not while typing", async () => {
    useShellHandlers();
    useAppHandlers();
    const view = renderAt("/acme/apps/hello/triggers");
    await screen.findByTestId("app-header");
    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, { key: "s" });
    await waitFor(() => expect(view.state.location.pathname).toBe("/acme/apps/hello/settings"));

    const input = document.body.appendChild(document.createElement("input"));
    fireEvent.keyDown(input, { key: "g" });
    fireEvent.keyDown(input, { key: "t" });
    input.remove();
    expect(view.state.location.pathname).toBe("/acme/apps/hello/settings");
  });

  it("tab bar scrolls the active tab into view and snaps", async () => {
    useShellHandlers();
    useAppHandlers();
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      renderAt("/acme/apps/hello/triggers");

      const nav = await screen.findByRole("navigation", { name: "App sections" });
      expect(nav.className).toContain("snap-x");
      const active = nav.querySelector('[aria-current="page"]') as HTMLElement;
      expect(active).toHaveTextContent("Triggers");
      await waitFor(() =>
        expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ inline: "center" })),
      );
      expect(scrollIntoView.mock.contexts[0]).toBe(active);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
