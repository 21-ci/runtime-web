import { screen, waitFor, within } from "@testing-library/react";
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

    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(screen.getByText(/boom: bad import/)).toBeInTheDocument();
  });

  it("sidebar carries the app navigation with the app identity", async () => {
    useShellHandlers();
    useAppHandlers();
    renderAt("/acme/apps/hello");
    const nav = await screen.findByRole("navigation", { name: /sidebar/i });
    expect(await within(nav).findByRole("link", { name: "All projects" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Env & Secrets" })).toHaveAttribute("href", "/acme/apps/hello/env");
    expect(within(nav).getByRole("link", { name: "Domains" })).toHaveAttribute("href", "/acme/apps/hello/domains");
    // The org navigation is replaced by the app's, so the project list (with its Empty project) is gone.
    expect(within(nav).queryByRole("link", { name: "Empty" })).toBeNull();
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
