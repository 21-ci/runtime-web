import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCsrfToken, setCsrfToken } from "@/lib/api";
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

  it('no "val" text in rendered routes', async () => {
    useShellHandlers();
    const paths = ["/acme", "/acme/projects/web", "/acme/projects/empty", "/acme/apps/new", "/acme/apps/hello", "/beta"];
    for (const path of paths) {
      cleanup();
      renderAt(path);
      await screen.findByRole("navigation", { name: /sidebar/i });
      await waitFor(() => expect(document.body.textContent ?? "").not.toMatch(/\bval\b/i));
    }
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
