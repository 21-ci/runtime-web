import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCsrfToken, setCsrfToken } from "@/lib/api";
import { apiError, server } from "./msw";
import { renderAt } from "./render";
import { me, useShellHandlers } from "./shell-fixtures";

// Pages are code-split, so the first render of a route (and each navigation to a new one) waits on
// a module import that can take seconds under a parallel run. Waits for those use LOAD; the
// per-test budget is raised for this file only so a LOAD wait cannot outlast the test.
const LOAD = { timeout: 5000 };

beforeEach(() => {
  setCsrfToken(null);
});

describe("app shell", { timeout: 15_000 }, () => {
  it("sidebar lists projects then apps", async () => {
    useShellHandlers();
    renderAt("/acme");
    const web = await screen.findByRole("link", { name: "Web" }, LOAD);
    const hello = await screen.findByRole("link", { name: "Hello" }, LOAD);
    expect(web.compareDocumentPosition(hello) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("cmd+k navigates to app", async () => {
    useShellHandlers();
    const router = renderAt("/acme");
    await screen.findByRole("link", { name: "Hello" }, LOAD);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const option = await screen.findByRole("option", { name: /Hello/ }, LOAD);
    await userEvent.click(option);
    await waitFor(() => expect(router.state.location.pathname).toBe("/acme/apps/hello"), LOAD);
  });

  it("org switcher changes scope and clears query cache", async () => {
    useShellHandlers();
    const router = renderAt("/acme");
    await screen.findByRole("link", { name: "Web" }, LOAD);
    const cache = router.options.context.queryClient.getQueryCache();
    expect(cache.find({ queryKey: ["projects", "acme"] })).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: /switch org/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Beta/ }, LOAD));

    await waitFor(() => expect(router.state.location.pathname).toBe("/beta"), LOAD);
    expect(cache.find({ queryKey: ["projects", "acme"] })).toBeUndefined();
  });

  it("empty project shows create-app CTA", async () => {
    useShellHandlers();
    renderAt("/acme/projects/empty");
    const cta = await screen.findByRole("link", { name: /create app/i }, LOAD);
    expect(cta.getAttribute("href")).toContain("/acme/apps/new");
    expect(cta.getAttribute("href")).toContain("project=empty");
  });

  it("app create offers project environments", async () => {
    useShellHandlers();
    renderAt("/acme/apps/new?project=web");
    const env = await screen.findByRole("combobox", { name: /environment/i }, LOAD);
    await userEvent.click(env);
    const listbox = await screen.findByRole("listbox", {}, LOAD);
    expect(within(listbox).getByRole("option", { name: "prod" })).toBeDefined();
    expect(within(listbox).getByRole("option", { name: "dev" })).toBeDefined();
  });

  it("quota bar renders limits read-only", async () => {
    useShellHandlers();
    renderAt("/acme");
    const quota = await screen.findByRole("region", { name: /quota/i }, LOAD);
    await within(quota).findByText(/invocations/i, undefined, LOAD);
    expect(within(quota).queryByRole("button")).toBeNull();
    expect(within(quota).queryByRole("textbox")).toBeNull();
  });

  it("usage card hidden for members", async () => {
    useShellHandlers();
    renderAt("/beta");
    await screen.findByText(/no projects/i, undefined, LOAD);
    expect(screen.queryByRole("region", { name: /usage/i })).toBeNull();
  });

  it("usage card shown for owners", async () => {
    useShellHandlers();
    renderAt("/acme");
    expect(await screen.findByRole("region", { name: /usage/i }, LOAD)).toBeDefined();
  });

  it("overview shows retry on projects error and recovers", async () => {
    useShellHandlers();
    server.use(http.get("/api/orgs/:org/projects", () => apiError(500, "internal")));
    renderAt("/acme");
    const main = await screen.findByRole("heading", { name: "Projects" }, LOAD);
    const retry = await within(main.parentElement as HTMLElement).findByRole("button", { name: "Retry" }, LOAD);

    useShellHandlers();
    await userEvent.click(retry);
    expect(await screen.findByRole("link", { name: "Web" }, LOAD)).toBeDefined();
  });

  it("sidebar shows an error with retry when projects fail", async () => {
    useShellHandlers();
    server.use(http.get("/api/orgs/:org/projects", () => apiError(500, "internal")));
    renderAt("/acme");
    const nav = await screen.findByRole("navigation", { name: /sidebar/i }, LOAD);
    expect(await within(nav).findByText(/could not load projects/i, undefined, LOAD)).toBeDefined();
    expect(within(nav).getByRole("button", { name: "Retry" })).toBeDefined();
  });

  it("quota bar shows retry on limits error", async () => {
    useShellHandlers();
    server.use(http.get("/api/orgs/:org/limits", () => apiError(500, "internal")));
    renderAt("/acme");
    const quota = await screen.findByRole("region", { name: /quota/i }, LOAD);
    expect(await within(quota).findByRole("button", { name: "Retry" }, LOAD)).toBeDefined();
  });

  it("project page shows not-found for a 404", async () => {
    useShellHandlers();
    renderAt("/acme/projects/missing");
    expect(await screen.findByText("Project not found", undefined, LOAD)).toBeDefined();
  });

  it("command menu offers New project to owners", async () => {
    useShellHandlers();
    renderAt("/acme");
    await screen.findByRole("link", { name: "Hello" }, LOAD);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(await screen.findByRole("option", { name: /New project/ }, LOAD)).toBeDefined();
  });

  it("mobile search button opens the command menu", async () => {
    useShellHandlers();
    renderAt("/acme");
    await screen.findByRole("link", { name: "Hello" }, LOAD);
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("option", { name: /New project/ }, LOAD)).toBeDefined();
  });

  it("command menu hides New project from members", async () => {
    useShellHandlers();
    renderAt("/beta");
    await screen.findByText(/no projects yet/i, undefined, LOAD);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await screen.findByRole("option", { name: /New app/ }, LOAD);
    expect(screen.queryByRole("option", { name: /New project/ })).toBeNull();
  });

  it("command menu hides admin settings from non-admins", async () => {
    useShellHandlers();
    renderAt("/acme");
    await screen.findByRole("link", { name: "Hello" }, LOAD);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await screen.findByRole("option", { name: /New project/ }, LOAD);
    expect(screen.queryByRole("option", { name: /Admin:/ })).toBeNull();
  });

  it("command menu shows admin settings to instance admins", async () => {
    useShellHandlers();
    server.use(http.get("/api/me", () => HttpResponse.json({ ...me, user: { ...me.user, instance_admin: true } })));
    renderAt("/acme");
    await screen.findByRole("link", { name: "Hello" }, LOAD);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(await screen.findByRole("option", { name: /Admin: users/ }, LOAD)).toBeDefined();
    expect(screen.getByRole("option", { name: /Admin: node/ })).toBeDefined();
  });

  it("logout clears the CSRF token and returns to login", async () => {
    const logout = vi.fn();
    useShellHandlers(logout);
    setCsrfToken("csrf-token-1");
    const router = renderAt("/acme");
    await screen.findByRole("link", { name: "Web" }, LOAD);
    await userEvent.click(screen.getByRole("button", { name: /account/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /log out/i }, LOAD));
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1), LOAD);
    await waitFor(() => expect(getCsrfToken()).toBeNull(), LOAD);
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"), LOAD);
  });

  it("logout clears the query cache so the next user never sees the previous org", async () => {
    useShellHandlers();
    setCsrfToken("csrf-token-1");
    const router = renderAt("/acme");
    await screen.findByRole("link", { name: "Web" }, LOAD);
    await userEvent.click(screen.getByRole("button", { name: /account/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /log out/i }, LOAD));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"), LOAD);

    // User B signs in in the same tab; their data never arrives, so anything shown is cached.
    const pending = () => new Promise<never>(() => {});
    server.use(
      http.get("/api/me", () => HttpResponse.json({ ...me, user: { ...me.user, id: "usr_2", email: "bob@example.test" } })),
      http.get("/api/orgs", pending),
      http.get("/api/orgs/:org/projects", pending),
      http.get("/api/orgs/:org/apps", pending),
    );
    await router.navigate({ href: "/acme" });
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole("link", { name: "Web" })).toBeNull();
    expect(screen.queryByText("Acme")).toBeNull();
  });

  it("a 401 redirect to login clears the query cache", async () => {
    useShellHandlers();
    const router = renderAt("/acme");
    await screen.findByRole("link", { name: "Web" }, LOAD);
    // The session expires: the next uncached fetch (org beta) answers 401.
    server.use(http.get("/api/orgs/:org/projects", () => apiError(401, "unauthenticated")));
    await router.navigate({ href: "/beta" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"), LOAD);
    const pending = () => new Promise<never>(() => {});
    server.use(http.get("/api/orgs", pending), http.get("/api/orgs/:org/projects", pending));
    await router.navigate({ href: "/acme" });
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole("link", { name: "Web" })).toBeNull();
  });
});
