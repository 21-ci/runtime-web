import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { setCsrfToken } from "@/lib/api";
import { server } from "./msw";
import { renderAt } from "./render";
import { apps, useShellHandlers } from "./shell-fixtures";

const audit = [
  {
    id: "a1",
    at: 1_700_000_000_000,
    actor: { user_id: "usr_1", name: "Ada", email: "ada@example.test" },
    as_instance_admin: false,
    org: { id: "org_1", slug: "acme" },
    action: "app.create",
    target: "web/hello",
    detail: null,
  },
];

function dashboardHandlers(opts: { audit?: unknown[] } = {}) {
  server.use(
    http.get("/api/orgs/:org/audit", () => HttpResponse.json({ items: opts.audit ?? audit, next_cursor: null })),
  );
}

beforeEach(() => setCsrfToken(null));

describe("org dashboard", { timeout: 15_000 }, () => {
  it("shows four compact quick actions", async () => {
    useShellHandlers();
    dashboardHandlers();
    renderAt("/acme");
    const actions = await screen.findByRole("region", { name: "Quick actions" });
    // New project is owner/admin only, so it appears once the org role has loaded.
    await within(actions).findByRole("button", { name: "New project" });
    expect(within(actions).getByRole("link", { name: "New app" })).toHaveAttribute("href", "/acme/apps/new");
    expect(within(actions).getByRole("link", { name: "Invite member" })).toBeInTheDocument();
    expect(within(actions).getByRole("link", { name: "Create token" })).toBeInTheDocument();
    expect(within(actions).queryByText("Add domain")).not.toBeInTheDocument();
  });

  it("lists apps in a table with their state and a link to all of them", async () => {
    useShellHandlers();
    dashboardHandlers();
    renderAt("/acme");
    const apps = await screen.findByRole("region", { name: "Apps" });
    const link = await within(apps).findByRole("link", { name: "Hello" });
    expect(link).toHaveAttribute("href", "/acme/apps/hello");
    const row = link.closest("tr") as HTMLElement;
    expect(within(row).getByText("Ready")).toBeInTheDocument();
    expect(within(row).getByText("v1")).toBeInTheDocument();
    expect(within(apps).getByRole("link", { name: "View all" })).toHaveAttribute("href", "/acme/apps");
  });

  it("shows activity from the audit log, at most what it asked for", async () => {
    useShellHandlers();
    let asked = "";
    server.use(
      http.get("/api/orgs/:org/audit", ({ request }) => {
        asked = new URL(request.url).search;
        return HttpResponse.json({ items: audit, next_cursor: null });
      }),
    );
    renderAt("/acme");
    const activity = await screen.findByRole("region", { name: "Activity" });
    expect(await within(activity).findByText("App create")).toBeInTheDocument();
    expect(within(activity).getByText("web/hello")).toBeInTheDocument();
    expect(within(activity).getByText("Ada")).toBeInTheDocument();
    expect(asked).toContain("limit=5");
  });

  it("no longer holds usage or members", async () => {
    useShellHandlers();
    dashboardHandlers();
    renderAt("/acme");
    await screen.findByRole("region", { name: "Apps" });
    expect(screen.queryByText("Usage today")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Members/ })).not.toBeInTheDocument();
  });

  it("shows empty states when there is nothing yet", async () => {
    useShellHandlers();
    dashboardHandlers({ audit: [] });
    renderAt("/acme");
    const activity = await screen.findByRole("region", { name: "Activity" });
    expect(await within(activity).findByText("No activity yet", {})).toBeInTheDocument();
  });
});

describe("apps page", { timeout: 15_000 }, () => {
  const more = [
    apps[0],
    { ...apps[0], slug: "worker", name: "Worker", project: "empty", environment: "prod", live_version: null, status: { build_state: "failed", tier: "standard", last_error: null } },
  ];

  it("filters by the URL and says when nothing matches", async () => {
    useShellHandlers();
    server.use(http.get("/api/orgs/:org/apps", () => HttpResponse.json({ items: more, next_cursor: null })));
    renderAt("/acme/apps?state=failed");
    const table = await screen.findByRole("table", { name: "Apps" });
    expect(await within(table).findByRole("link", { name: "Worker" })).toBeInTheDocument();
    expect(within(table).queryByRole("link", { name: "Hello" })).not.toBeInTheDocument();
    expect(screen.getByText("1 of 2 apps")).toBeInTheDocument();
    expect(screen.getByText("Not live")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Filter apps" }), "zzz");
    expect(await screen.findByText("No apps match these filters.")).toBeInTheDocument();
  });

  it("sorts by name", async () => {
    useShellHandlers();
    server.use(http.get("/api/orgs/:org/apps", () => HttpResponse.json({ items: more, next_cursor: null })));
    renderAt("/acme/apps");
    await screen.findByRole("link", { name: "Worker" });
    await userEvent.click(screen.getByRole("button", { name: "App" }));
    await userEvent.click(screen.getByRole("button", { name: "App" }));
    const names = screen.getAllByRole("link").filter((l) => /^(Hello|Worker)$/.test(l.textContent ?? "") && l.closest("tr"));
    expect(names.map((l) => l.textContent)).toEqual(["Worker", "Hello"]);
  });
});

describe("usage page", { timeout: 15_000 }, () => {
  it("lists today's UTC usage per app with a server export", async () => {
    useShellHandlers();
    const day = new Date().toISOString().slice(0, 10);
    let asked = "";
    server.use(
      http.get("/api/orgs/:org/plan-usage", () => HttpResponse.json({ plan: null, resets_at: null, metrics: [] })),
      http.get("/api/orgs/:org/usage", ({ request }) => {
        asked = new URL(request.url).search;
        return HttpResponse.json({ items: [{ app: "hello", day, invocations: 6, cpu_ms: 10, egress_bytes: 0, storage_bytes: 0 }, { app: null, day, invocations: 2, cpu_ms: 1, egress_bytes: 0, storage_bytes: 0 }] });
      }),
    );
    renderAt("/acme/settings/usage");
    const card = await screen.findByRole("region", { name: "Usage today by app" });
    expect(await within(card).findByText("hello")).toBeInTheDocument();
    expect(within(card).getByText("Deleted app")).toBeInTheDocument();
    await waitFor(() => expect(asked).toBe(`?from=${day}&to=${day}`));
    expect(within(card).getByRole("link", { name: "Export" })).toHaveAttribute("href", `/api/orgs/acme/usage?format=csv&from=${day}&to=${day}`);
  });

  it("tells a member the table is for admins and asks nothing", async () => {
    useShellHandlers();
    let asked = false;
    server.use(
      http.get("/api/orgs/:org/plan-usage", () => HttpResponse.json({ plan: null, resets_at: null, metrics: [] })),
      http.get("/api/orgs/:org/usage", () => ((asked = true), HttpResponse.json({ items: [] }))),
    );
    renderAt("/beta/settings/usage");
    expect(await screen.findByText("Only org owners and admins can see usage by app.")).toBeInTheDocument();
    expect(asked).toBe(false);
  });
});
