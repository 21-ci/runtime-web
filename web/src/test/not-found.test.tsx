import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw";
import { renderAt } from "@/test/render";
import { useShellHandlers } from "@/test/shell-fixtures";

describe("not found", () => {
  it("an org the caller cannot see gets one 404 and no shell naming it", async () => {
    useShellHandlers();
    server.use(http.get("/api/orgs/nonsense/projects", () => HttpResponse.json({ error: { code: "not_found", message: "x" } }, { status: 404 })));
    renderAt("/nonsense/page");
    await waitFor(() => expect(screen.getByRole("link", { name: "Go to the console home" })).toHaveAttribute("href", "/"));
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.queryByText("nonsense")).toBeNull();
    expect(screen.queryByLabelText(/switch/i)).toBeNull();
  });

  it("an unknown page inside an org links back to it", async () => {
    useShellHandlers();
    renderAt("/acme/nothing-here");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the console home" })).toHaveAttribute("href", "/acme");
  });

  it("a missing app shows no app navigation", async () => {
    useShellHandlers();
    server.use(http.get("/api/orgs/:org/apps/:app", () => HttpResponse.json({ error: { code: "not_found", message: "no" } }, { status: 404 })));
    renderAt("/acme/apps/does-not-exist");
    expect(await screen.findByText("App not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to the organization/i })).toHaveAttribute("href", "/acme");
    expect(screen.queryByRole("group", { name: /app navigation/i })).toBeNull();
    expect(screen.queryByText("does-not-exist")).toBeNull();
  });
});
