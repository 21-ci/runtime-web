import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { api, setCsrfToken } from "@/lib/api";
import { renderAt } from "@/test/render";
import { apiError, server, testUser } from "@/test/msw";

// Pages are code-split, so the first render of a route (and each navigation to a new one) waits on
// a module import that can take seconds under a parallel run. Waits for those use LOAD; the
// per-test budget is raised for this file only so a LOAD wait cannot outlast the test.
const LOAD = { timeout: 5000 };

function session() {
  return HttpResponse.json({ mfa_required: false, user: testUser, csrf: "csrf-1" });
}

describe("auth pages", { timeout: 15_000 }, () => {
  it("after a reload, a mutation sends the CSRF token from GET /api/me", async () => {
    setCsrfToken(null); // fresh module state, as after a reload
    server.use(
      http.get("/api/me", () =>
        HttpResponse.json({
          user: testUser,
          csrf: "csrf-reload",
          orgs: [],
          policy: { require_2fa: false, password_login_disabled: false },
          mfa_enrollment_required: false,
        }),
      ),
    );
    let seen: string | null = null;
    server.use(
      http.post("/api/orgs/acme/projects", ({ request }) => {
        seen = request.headers.get("X-CSRF-Token");
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const router = renderAt("/login");
    await router.load();

    await api.post("/orgs/acme/projects", { slug: "web" });
    expect(seen).toBe("csrf-reload");
    setCsrfToken(null);
  });

  it("login submits and redirects to next", async () => {
    server.use(http.post("/api/auth/login", session));
    const router = renderAt("/login?next=/orgs/acme/apps");
    const user = userEvent.setup({ delay: null });

    await user.type(await screen.findByLabelText("Email", undefined, LOAD), "ada@example.test");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/orgs/acme/apps"), LOAD);
  });

  it("login asks for TOTP code when mfa_required (recovery-code link too)", async () => {
    server.use(http.post("/api/auth/login", () => HttpResponse.json({ mfa_required: true })));
    const router = renderAt("/login?next=/orgs/acme/apps");
    const user = userEvent.setup({ delay: null });

    await user.type(await screen.findByLabelText("Email", undefined, LOAD), "ada@example.test");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/login/mfa"), LOAD);
    expect(await screen.findByLabelText("Authentication code", undefined, LOAD)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Use a recovery code" }));
    expect(await screen.findByLabelText("Recovery code")).toBeInTheDocument();
  });

  it("mfa page posts the code and lands on next", async () => {
    let body: unknown = null;
    server.use(
      http.post("/api/auth/mfa", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ user: testUser, csrf: "csrf-2" });
      }),
    );
    const router = renderAt("/login/mfa?next=/orgs/acme/apps");
    const user = userEvent.setup({ delay: null });

    await user.type(await screen.findByLabelText("Authentication code", undefined, LOAD), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/orgs/acme/apps"), LOAD);
    expect(body).toEqual({ code: "123456" });
  });

  it("password form hidden when SSO-only", async () => {
    server.use(
      http.get("/api/auth/providers", () =>
        HttpResponse.json({
          password_login_disabled: true,
          providers: [{ id: "github", name: "GitHub" }],
        }),
      ),
    );
    renderAt("/login");
    const user = userEvent.setup({ delay: null });

    const sso = await screen.findByRole("link", { name: "Continue with GitHub" }, LOAD);
    expect(sso).toHaveAttribute("href", "/api/auth/oauth/github/start?next=%2F");
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();

    // Break-glass for instance admins.
    await user.click(screen.getByRole("button", { name: "Sign in with password" }));
    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
  });

  it("setup page only when GET /api/setup says needed", async () => {
    const router = renderAt("/setup");
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"), LOAD);
  });

  it("setup asks for setup token", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.get("/api/setup", () => HttpResponse.json({ needed: true })),
      http.post("/api/setup", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ user: testUser, csrf: "csrf-3" }, { status: 201 });
      }),
    );
    const router = renderAt("/setup");
    const user = userEvent.setup({ delay: null });

    await user.type(await screen.findByLabelText("Setup token", undefined, LOAD), "tok-abc");
    await user.type(screen.getByLabelText("Email"), "ada@example.test");
    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Create admin" }));

    await waitFor(() => expect(body).not.toBeNull(), LOAD);
    expect(body).toMatchObject({ setup_token: "tok-abc", email: "ada@example.test" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/"), LOAD);
  });

  it("invite link sets password", async () => {
    let body: unknown = null;
    server.use(
      http.get("/api/invites/accept/tok-1", () =>
        HttpResponse.json({ email: "new@example.test", org_name: "Acme" }),
      ),
      http.post("/api/invites/accept/tok-1", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ email: "new@example.test" });
      }),
    );
    const router = renderAt("/invite/tok-1");
    const user = userEvent.setup({ delay: null });

    expect(await screen.findByText("new@example.test", undefined, LOAD)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Name"), "New Person");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Accept invite" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"), LOAD);
    expect(body).toEqual({ name: "New Person", password: "correct horse battery" });
  });

  it("invite accept asks to sign in when the account must sign in first", async () => {
    server.use(
      http.get("/api/invites/accept/tok-2", () =>
        HttpResponse.json({ email: "old@example.test", org_name: "Acme" }),
      ),
      http.post("/api/invites/accept/tok-2", () => apiError(403, "invite_login_required")),
    );
    renderAt("/invite/tok-2");
    const user = userEvent.setup({ delay: null });

    await user.type(await screen.findByLabelText("Name", undefined, LOAD), "Old Person");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Accept invite" }));

    const alert = await screen.findByRole("alert", undefined, LOAD);
    expect(within(alert).getByRole("link", { name: "Sign in to accept" })).toBeInTheDocument();
  });
});
