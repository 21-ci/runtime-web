import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw";
import { renderAt } from "@/test/render";
import { useShellHandlers } from "@/test/shell-fixtures";

describe("new app form", () => {
  it("rejects a slug that is not a DNS label before calling the API", async () => {
    useShellHandlers();
    let posted = false;
    server.use(
      http.post("/api/orgs/acme/apps", () => {
        posted = true;
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    renderAt("/acme/apps/new");
    const slug = await screen.findByLabelText("App name");
    await userEvent.type(slug, "Bad--Name");
    await userEvent.click(screen.getByRole("button", { name: "Create app" }));
    expect(await screen.findByText(/lowercase letters, digits and single hyphens/i)).toBeInTheDocument();
    expect(posted).toBe(false);
  });

  it("shows the server's slug pattern error inline", async () => {
    useShellHandlers();
    server.use(
      http.post("/api/orgs/acme/apps", () =>
        HttpResponse.json(
          { error: { code: "invalid", message: "invalid", details: { fields: { slug: "pattern" } } } },
          { status: 422 },
        ),
      ),
    );
    renderAt("/acme/apps/new");
    await userEvent.type(await screen.findByLabelText("App name"), "ok-name");
    const create = screen.getByRole("button", { name: "Create app" });
    await waitFor(() => expect(create).toBeEnabled());
    await userEvent.click(create);
    expect(await screen.findByText(/lowercase letters, digits and single hyphens/i)).toBeInTheDocument();
  });

  it("shows why Create is disabled while environments load", async () => {
    useShellHandlers();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get("/api/orgs/:org/projects/:p/environments", async () => {
        await gate;
        return HttpResponse.json({ items: ["production"] });
      }),
    );
    renderAt("/acme/apps/new");
    const create = await screen.findByRole("button", { name: "Create app" });
    await waitFor(() => expect(create).toBeDisabled());
    expect(screen.getAllByText("Loading environments…").length).toBeGreaterThan(0);
    release();
    await waitFor(() => expect(create).toBeEnabled());
    expect(screen.queryByText("Loading environments…")).toBeNull();
  });

  it("explains a project without environments", async () => {
    useShellHandlers();
    server.use(http.get("/api/orgs/:org/projects/:p/environments", () => HttpResponse.json({ items: [] })));
    renderAt("/acme/apps/new");
    expect(await screen.findByText("This project has no environments yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create app" })).toBeDisabled();
  });
});

describe("setup page", () => {
  it("explains where the setup token comes from", async () => {
    server.use(http.get("/api/setup", () => HttpResponse.json({ needed: true })));
    renderAt("/setup");
    expect(await screen.findByText(/RTWEB_SETUP_TOKEN/)).toBeInTheDocument();
  });
});
