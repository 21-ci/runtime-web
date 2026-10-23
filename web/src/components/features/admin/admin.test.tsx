import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setCsrfToken } from "@/lib/api";
import { server } from "@/test/msw";
import { renderAt } from "@/test/render";
import { me, useShellHandlers } from "@/test/shell-fixtures";

const adminMe = { ...me, user: { ...me.user, instance_admin: true } };

const adminUsers = [
  {
    id: "usr_1",
    email: "ada@example.test",
    name: "Ada",
    instance_admin: true,
    must_change_password: false,
    disabled: false,
    totp_enabled: false,
    created_at: 1,
  },
  {
    id: "usr_2",
    email: "grace@example.test",
    name: "Grace",
    instance_admin: false,
    must_change_password: false,
    disabled: false,
    totp_enabled: true,
    created_at: 2,
  },
];

const adminOrgs = [{ id: "org_1", slug: "acme", name: "Acme", created_at: 1, role: null }];

// adminHandlers serves the instance-admin reads every admin page makes on first render.
function adminHandlers() {
  return [
    http.get("/api/me", () => HttpResponse.json(adminMe)),
    http.get("/api/admin/users", () => HttpResponse.json({ items: adminUsers, next_cursor: null })),
    http.get("/api/admin/orgs", () => HttpResponse.json({ items: adminOrgs })),
    http.get("/api/admin/invites", () => HttpResponse.json({ items: [] })),
    http.get("/api/admin/orgs/:org/usage", () => HttpResponse.json({ items: [] })),
    http.get("/api/admin/audit", () => HttpResponse.json({ items: [], next_cursor: null })),
  ];
}

// useAdminFixtures serves the shell reads plus the instance-admin reads, after the non-admin shell
// defaults so the admin /api/me wins.
function useAdminFixtures() {
  useShellHandlers();
  server.use(...adminHandlers());
}

// The first route render transforms the page modules, which can take over the default 1s wait.
configure({ asyncUtilTimeout: 4000 });
vi.setConfig({ testTimeout: 15_000 });

beforeEach(() => {
  setCsrfToken(null);
});

describe("admin pages", () => {
  it("non-admin is redirected from /admin", async () => {
    // The shell fixture signs in a non-admin user, so the admin gate must bounce the route.
    useShellHandlers();
    const router = renderAt("/admin/users");
    await waitFor(() => expect(router.state.location.pathname).not.toMatch(/^\/admin/));
  });

  it("temp password shown once", async () => {
    useAdminFixtures();
    server.use(
      http.post("/api/admin/users", async ({ request }) => {
        const body = (await request.json()) as { email: string };
        return HttpResponse.json(
          {
            user: { ...adminUsers[1], id: "usr_3", email: body.email, name: "Linus" },
            temp_password: "Tmp-Pass-9xQ2-belt",
          },
          { status: 201 },
        );
      }),
    );
    renderAt("/admin/users");

    await userEvent.click(await screen.findByRole("button", { name: /new user/i }));
    const dialog = await screen.findByRole("dialog", { name: /new user/i });
    await userEvent.type(within(dialog).getByLabelText(/email/i), "linus@example.test");
    await userEvent.type(within(dialog).getByLabelText(/^name/i), "Linus");
    await userEvent.click(within(dialog).getByRole("button", { name: /create user/i }));

    expect(await within(dialog).findByText("Tmp-Pass-9xQ2-belt")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /copy/i })).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: /done/i }));
    await waitFor(() => expect(screen.queryByText("Tmp-Pass-9xQ2-belt")).not.toBeInTheDocument());
  });

  it("invite link shown once", async () => {
    useAdminFixtures();
    const link = "https://rt.example.test/invite/tok-abc123";
    server.use(
      http.post("/api/admin/invites", () =>
        HttpResponse.json(
          {
            invite: {
              id: "inv_1",
              email: "linus@example.test",
              org: null,
              role: null,
              created_by: { id: "usr_1", name: "Ada" },
              created_at: 1,
              expires_at: 2,
            },
            link,
          },
          { status: 201 },
        ),
      ),
    );
    renderAt("/admin/users");

    await userEvent.click(await screen.findByRole("button", { name: /create invite link/i }));
    const dialog = await screen.findByRole("dialog", { name: /invite link/i });
    await userEvent.type(within(dialog).getByLabelText(/email/i), "linus@example.test");
    await userEvent.click(within(dialog).getByRole("button", { name: /create invite link/i }));

    expect(await within(dialog).findByText(link)).toBeInTheDocument();
    expect(within(dialog).getByText(/shown once/i)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: /done/i }));
    await waitFor(() => expect(screen.queryByText(link)).not.toBeInTheDocument());
  });

  it("reset 2fa requires confirmation", async () => {
    useAdminFixtures();
    let resets = 0;
    server.use(
      http.delete("/api/admin/users/:id/totp", () => {
        resets += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderAt("/admin/users");

    await userEvent.click(await screen.findByRole("button", { name: /actions for grace/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /reset 2fa/i }));
    const dialog = await screen.findByRole("dialog", { name: /reset 2fa for grace/i });
    expect(resets).toBe(0);

    await userEvent.click(within(dialog).getByRole("button", { name: /reset 2fa/i }));
    await waitFor(() => expect(resets).toBe(1));
  });

  it("delete user explains the soft delete", async () => {
    useAdminFixtures();
    renderAt("/admin/users");

    await userEvent.click(await screen.findByRole("button", { name: /actions for grace/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /delete user/i }));
    const dialog = await screen.findByRole("dialog", { name: /delete grace/i });
    expect(within(dialog).getByText(/disables the account/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/anonymizes/i)).toBeInTheDocument();
  });

  it("admin audit filters by org and actor", async () => {
    useAdminFixtures();
    const seen: URLSearchParams[] = [];
    server.use(
      http.get("/api/admin/audit", ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json({ items: [], next_cursor: null });
      }),
    );
    renderAt("/admin/audit");

    const orgSelect = await screen.findByLabelText(/organization/i);
    await within(orgSelect).findByRole("option", { name: /Acme/ });
    await userEvent.selectOptions(orgSelect, "acme");

    const actorSelect = await screen.findByLabelText(/actor/i);
    await within(actorSelect).findByRole("option", { name: /Grace/ });
    await userEvent.selectOptions(actorSelect, "usr_2");

    await waitFor(() => expect(seen.at(-1)?.get("org")).toBe("acme"));
    expect(seen.at(-1)?.get("actor")).toBe("usr_2");
  });
});
