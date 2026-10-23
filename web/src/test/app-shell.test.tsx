import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCsrfToken, setCsrfToken } from "@/lib/api";
import { apiError, server } from "./msw";
import { renderAt } from "./render";
import { useShellHandlers } from "./shell-fixtures";

beforeEach(() => {
  setCsrfToken(null);
});

describe("app shell", () => {
  it("sidebar lists projects then apps", async () => {
    useShellHandlers();
    renderAt("/acme");
    const web = await screen.findByRole("link", { name: "Web" });
    const hello = await screen.findByRole("link", { name: "Hello" });
    expect(web.compareDocumentPosition(hello) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("cmd+k navigates to app", async () => {
    useShellHandlers();
    const router = renderAt("/acme");
    await screen.findByRole("link", { name: "Hello" });
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const option = await screen.findByRole("option", { name: /Hello/ });
    await userEvent.click(option);
    await waitFor(() => expect(router.state.location.pathname).toBe("/acme/apps/hello"));
  });

  it("org switcher changes scope and clears query cache", async () => {
    useShellHandlers();
    const router = renderAt("/acme");
    await screen.findByRole("link", { name: "Web" });
    const cache = router.options.context.queryClient.getQueryCache();
    expect(cache.find({ queryKey: ["projects", "acme"] })).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: /switch org/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Beta/ }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/beta"));
    expect(cache.find({ queryKey: ["projects", "acme"] })).toBeUndefined();
  });

  it("empty project shows create-app CTA", async () => {
    useShellHandlers();
    renderAt("/acme/projects/empty");
    const cta = await screen.findByRole("link", { name: /create app/i });
    expect(cta.getAttribute("href")).toContain("/acme/apps/new");
    expect(cta.getAttribute("href")).toContain("project=empty");
  });

  it("app create offers project environments", async () => {
    useShellHandlers();
    renderAt("/acme/apps/new?project=web");
    const env = await screen.findByRole("combobox", { name: /environment/i });
    await waitFor(() => expect(within(env).getByRole("option", { name: "prod" })).toBeDefined());
    expect(within(env).getByRole("option", { name: "dev" })).toBeDefined();
  });

  it("quota bar renders limits read-only", async () => {
    useShellHandlers();
    renderAt("/acme");
    const quota = await screen.findByRole("region", { name: /quota/i });
    await within(quota).findByText(/invocations/i);
    expect(within(quota).queryByRole("button")).toBeNull();
    expect(within(quota).queryByRole("textbox")).toBeNull();
  });

  it("usage card hidden for members", async () => {
    useShellHandlers();
    renderAt("/beta");
    await screen.findByText(/no projects/i);
    expect(screen.queryByRole("region", { name: /usage/i })).toBeNull();
  });

  it("usage card shown for owners", async () => {
    useShellHandlers();
    renderAt("/acme");
    expect(await screen.findByRole("region", { name: /usage/i })).toBeDefined();
  });

  it("overview shows retry on projects error and recovers", async () => {
    useShellHandlers();
    server.use(http.get("/api/orgs/:org/projects", () => apiError(500, "internal")));
    renderAt("/acme");
    const main = await screen.findByRole("heading", { name: "Projects" });
    const retry = await within(main.parentElement as HTMLElement).findByRole("button", { name: "Retry" });

    useShellHandlers();
    await userEvent.click(retry);
    expect(await screen.findByRole("link", { name: "Web" })).toBeDefined();
  });

  it("sidebar shows an error with retry when projects fail", async () => {
    useShellHandlers();
    server.use(http.get("/api/orgs/:org/projects", () => apiError(500, "internal")));
    renderAt("/acme");
    const nav = await screen.findByRole("navigation", { name: /sidebar/i });
    expect(await within(nav).findByText(/could not load projects/i)).toBeDefined();
    expect(within(nav).getByRole("button", { name: "Retry" })).toBeDefined();
  });

  it("quota bar shows retry on limits error", async () => {
    useShellHandlers();
    server.use(http.get("/api/orgs/:org/limits", () => apiError(500, "internal")));
    renderAt("/acme");
    const quota = await screen.findByRole("region", { name: /quota/i });
    expect(await within(quota).findByRole("button", { name: "Retry" })).toBeDefined();
  });

  it("project page shows not-found for a 404", async () => {
    useShellHandlers();
    renderAt("/acme/projects/missing");
    expect(await screen.findByText("Project not found")).toBeDefined();
  });

  it("command menu offers New project to owners", async () => {
    useShellHandlers();
    renderAt("/acme");
    await screen.findByRole("link", { name: "Hello" });
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(await screen.findByRole("option", { name: /New project/ })).toBeDefined();
  });

  it("command menu hides New project from members", async () => {
    useShellHandlers();
    renderAt("/beta");
    await screen.findByText(/no projects yet/i);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await screen.findByRole("option", { name: /New app/ });
    expect(screen.queryByRole("option", { name: /New project/ })).toBeNull();
  });

  it("logout clears the CSRF token and returns to login", async () => {
    const logout = vi.fn();
    useShellHandlers(logout);
    setCsrfToken("csrf-token-1");
    const router = renderAt("/acme");
    await screen.findByRole("link", { name: "Web" });
    await userEvent.click(screen.getByRole("button", { name: /account/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /log out/i }));
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getCsrfToken()).toBeNull());
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });
});
