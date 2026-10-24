import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { setCsrfToken } from "@/lib/api";
import { server } from "./msw";
import { renderAt } from "./render";
import { useShellHandlers } from "./shell-fixtures";

const LOAD = { timeout: 5000 };

const members = [
  { user: { id: "usr_1", email: "ada@example.test", name: "Ada" }, role: "owner", grants: {} },
  { user: { id: "usr_2", email: "grace@example.test", name: "Grace" }, role: "member", grants: {} },
];

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

function dashboardHandlers(opts: { members?: unknown[]; audit?: unknown[] } = {}) {
  server.use(
    http.get("/api/orgs/:org/members", () => HttpResponse.json({ items: opts.members ?? members })),
    http.get("/api/orgs/:org/audit", () => HttpResponse.json({ items: opts.audit ?? audit, next_cursor: null })),
  );
}

beforeEach(() => setCsrfToken(null));

describe("org dashboard", { timeout: 15_000 }, () => {
  it("shows quick actions with titles and subtitles", async () => {
    useShellHandlers();
    dashboardHandlers();
    renderAt("/acme");
    const actions = await screen.findByRole("region", { name: "Quick actions" }, LOAD);
    // New project is owner/admin only, so it appears once the org role has loaded.
    await within(actions).findByText("New project", {}, LOAD);
    for (const name of ["New app", "New project", "Invite member", "Create token", "Add domain"]) {
      expect(within(actions).getByText(name)).toBeInTheDocument();
    }
  });

  it("lists apps as tiles with a status line", async () => {
    useShellHandlers();
    dashboardHandlers();
    renderAt("/acme");
    const apps = await screen.findByRole("region", { name: "Apps" }, LOAD);
    const tile = await within(apps).findByRole("link", { name: /Hello/ }, LOAD);
    expect(tile).toHaveTextContent(/ready/i);
    expect(tile).toHaveAttribute("href", "/acme/apps/hello");
  });

  it("shows recent activity from the audit log", async () => {
    useShellHandlers();
    dashboardHandlers();
    renderAt("/acme");
    const activity = await screen.findByRole("region", { name: "Recent activity" }, LOAD);
    expect(await within(activity).findByText("app.create", {}, LOAD)).toBeInTheDocument();
    expect(within(activity).getByText(/web\/hello/)).toBeInTheDocument();
  });

  it("shows members with name and email", async () => {
    useShellHandlers();
    dashboardHandlers();
    renderAt("/acme");
    const people = await screen.findByRole("region", { name: /Members/ }, LOAD);
    expect(await within(people).findByText("Grace", {}, LOAD)).toBeInTheDocument();
    expect(within(people).getByText("grace@example.test")).toBeInTheDocument();
  });

  it("shows empty states when there is nothing yet", async () => {
    useShellHandlers();
    dashboardHandlers({ audit: [] });
    renderAt("/acme");
    const activity = await screen.findByRole("region", { name: "Recent activity" }, LOAD);
    expect(await within(activity).findByText("No activity yet", {}, LOAD)).toBeInTheDocument();
  });
});
