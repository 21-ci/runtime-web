import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { setCsrfToken } from "@/lib/api";
import { server } from "@/test/msw";
import { renderAt } from "@/test/render";
import { useShellHandlers } from "@/test/shell-fixtures";

import { useAppHandlers } from "../app-header/fixtures";

beforeEach(() => {
  setCsrfToken("csrf-token-1");
});

describe("app overview", () => {
  const versions = [
    { version: 1, build_state: "ready", live: false, source_digest: null, failure: null, author: null, created_at: 1_700_000_000_000 },
    { version: 2, build_state: "ready", live: true, source_digest: null, failure: null, author: { user_id: "usr_1", name: "Ada" }, created_at: 1_700_000_100_000 },
  ];
  const withVersions = (items: unknown[] = versions) => server.use(http.get("/api/orgs/:org/apps/:app/versions", () => HttpResponse.json({ items })));

  it("shows the last hour in four tiles", async () => {
    useShellHandlers();
    useAppHandlers();
    withVersions();
    let asked = "";
    server.use(
      http.get("/api/orgs/:org/apps/:app/stats", ({ request }) => {
        asked = new URL(request.url).search;
        return HttpResponse.json({ requests: 42, errors: 2, error_rate: 0.05, p95_ms: 80 });
      }),
    );
    renderAt("/acme/apps/hello");
    const stats = await screen.findByRole("region", { name: "Last hour" });
    expect(await within(stats).findByText("42")).toBeInTheDocument();
    expect(within(stats).getByText("80 ms")).toBeInTheDocument();
    expect(within(stats).getByText("5.0%")).toBeInTheDocument();
    expect(asked).toBe("?window=1h");
  });

  it("replaces the tiles with one sentence when there were no requests", async () => {
    useShellHandlers();
    useAppHandlers();
    withVersions();
    server.use(http.get("/api/orgs/:org/apps/:app/stats", () => HttpResponse.json({ requests: 0, errors: 0 })));
    renderAt("/acme/apps/hello");
    const stats = await screen.findByRole("region", { name: "Last hour" });
    expect(await within(stats).findByText("No requests in the last hour.")).toBeInTheDocument();
    expect(within(stats).queryByText("p95")).not.toBeInTheDocument();
    expect(within(stats).getByRole("link", { name: "View logs" })).toHaveAttribute("href", "/acme/apps/hello/logs");
  });

  it("shows the newest version as the last deployment", async () => {
    useShellHandlers();
    useAppHandlers();
    withVersions();
    renderAt("/acme/apps/hello");
    const card = await screen.findByRole("region", { name: "Last deployment" });
    expect(await within(card).findByText("v2")).toBeInTheDocument();
    expect(within(card).getByText("Ada")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Deployments" })).toHaveAttribute("href", "/acme/apps/hello/deployments");
  });

  it("says a version made outside the console came from the CLI or API", async () => {
    useShellHandlers();
    useAppHandlers();
    withVersions([versions[0]]);
    renderAt("/acme/apps/hello");
    const card = await screen.findByRole("region", { name: "Last deployment" });
    expect(await within(card).findByText("CLI or API")).toBeInTheDocument();
  });

  it("shows the last five activity items in words, with no raw view", async () => {
    useShellHandlers();
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `e${i}`, ts: 1_700_000_000_000 - i, kind: "build.failed", data: { reason: "syntax" } }));
    useAppHandlers({ events: [{ id: "ev_1", ts: 1_700_000_000_001, kind: "version.live", data: { version: 1 } }, ...many] as never });
    withVersions();
    renderAt("/acme/apps/hello");
    const card = await screen.findByRole("region", { name: "Activity" });
    expect(await within(card).findByText("Version went live")).toBeInTheDocument();
    expect(within(card).getAllByText("Build failed")).toHaveLength(4);
    expect(within(card).queryByText("Raw")).not.toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "View all" })).toHaveAttribute("href", "/acme/apps/hello/deployments");
  });

  it("leaves identity, the code list and the data export to other pages", async () => {
    useShellHandlers();
    useAppHandlers();
    withVersions();
    renderAt("/acme/apps/hello");
    await screen.findByRole("region", { name: "Activity" });
    expect(screen.queryByRole("region", { name: "Code" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /export data/i })).not.toBeInTheDocument();
    expect(screen.queryAllByRole("heading", { level: 1 }).length).toBeLessThanOrEqual(1);
  });
});
