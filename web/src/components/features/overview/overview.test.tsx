import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setCsrfToken } from "@/lib/api";
import { server } from "@/test/msw";
import { renderAt } from "@/test/render";
import { projects, useShellHandlers } from "@/test/shell-fixtures";

import { useAppHandlers } from "../app-header/fixtures";

// Routes are code-split, so the first render of each test waits on a lazy chunk.
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  setCsrfToken("csrf-token-1");
});

describe("overview", () => {
  it("events panel lists runtime events", async () => {
    useShellHandlers();
    useAppHandlers();
    renderAt("/acme/apps/hello");

    expect(await screen.findByText("version.live")).toBeInTheDocument();
    expect(screen.getByText("build.failed")).toBeInTheDocument();
  });

  it("export hidden for developer", async () => {
    useShellHandlers();
    useAppHandlers();
    server.use(
      http.get("/api/orgs/:org/projects", () =>
        HttpResponse.json({ items: projects.map((p) => ({ ...p, role: "developer" })) }),
      ),
    );
    renderAt("/acme/apps/hello");

    await screen.findByText("version.live");
    expect(screen.queryByRole("link", { name: /export data/i })).not.toBeInTheDocument();
  });

  it("export shown for project admin", async () => {
    useShellHandlers();
    useAppHandlers();
    renderAt("/acme/apps/hello");

    const link = await screen.findByRole("link", { name: /export data/i });
    expect(link.getAttribute("href")).toContain("/api/orgs/acme/apps/hello/export");
  });
});
