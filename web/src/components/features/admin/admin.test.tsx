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
    const dialog = await screen.findByRole("alertdialog", { name: /reset 2fa for grace/i });
    expect(resets).toBe(0);

    await userEvent.click(within(dialog).getByRole("button", { name: /reset 2fa/i }));
    await waitFor(() => expect(resets).toBe(1));
  });

  it("delete user explains the soft delete", async () => {
    useAdminFixtures();
    renderAt("/admin/users");

    await userEvent.click(await screen.findByRole("button", { name: /actions for grace/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /delete user/i }));
    const dialog = await screen.findByRole("alertdialog", { name: /delete grace/i });
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

const settings = {
  public_url: "https://console.example.test",
  require_2fa: false,
  password_login_disabled: false,
  providers: [
    { id: "github", enabled: false, client_id: "", client_secret_set: false },
    { id: "google", enabled: false, client_id: "", client_secret_set: false },
    { id: "oidc", enabled: false, client_id: "", client_secret_set: false, issuer: "", name: "" },
  ],
};

const domains = {
  items: [
    {
      id: "dom_1",
      host: "a.example.test",
      app: "hello",
      status: "active",
      txt_name: "_rtweb.a.example.test",
      txt_value: "0".repeat(32),
      cname_target: "router.example.test",
      last_checked_at: null,
      verified_at: null,
      cert_status: "issued",
      cert_not_after: 1_900_000_000_000,
      cert_error: null,
      created_at: 1,
      org: { slug: "acme", name: "Acme" },
    },
    {
      id: "dom_2",
      host: "b.example.test",
      app: "shop",
      status: "pending",
      txt_name: "_rtweb.b.example.test",
      txt_value: "1".repeat(32),
      cname_target: "router.example.test",
      last_checked_at: null,
      verified_at: null,
      cert_status: "none",
      cert_not_after: null,
      cert_error: null,
      created_at: 1,
      org: { slug: "beta", name: "Beta" },
    },
  ],
};

// useAdminStubs signs in an instance admin and answers every admin read the four pages make.
function useAdminStubs() {
  useAdminFixtures();
  server.use(
    http.get("/api/admin/node/status", () => HttpResponse.json({ state: "running", uptime_s: 3600 })),
    http.get("/api/admin/node/scheduler", () => HttpResponse.json({ queued: 7 })),
    http.get("/api/admin/node/config", () =>
      HttpResponse.json({ degradation_mode: "shed", default_profile: "small", rate_limit: { rps: 10 } }),
    ),
    http.get("/api/admin/node/cache", () => HttpResponse.json({ entries: 42, hit_ratio: 0.93 })),
    http.get("/api/admin/domains", () => HttpResponse.json(domains)),
    http.get("/api/admin/settings", () => HttpResponse.json(settings)),
  );
}

describe("admin node", () => {
  it("drain requires typed confirmation", async () => {
    useAdminStubs();
    const drain = vi.fn();
    server.use(
      http.post("/api/admin/node/drain", async ({ request }) => {
        drain(await request.json());
        return HttpResponse.json({ draining: true }, { status: 202 });
      }),
    );
    renderAt("/admin/node");

    await userEvent.click(await screen.findByRole("button", { name: "Drain node" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Drain node" });
    expect(confirm).toBeDisabled();

    await userEvent.type(within(dialog).getByLabelText("Type drain to confirm"), "drain");
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(drain).toHaveBeenCalledWith({ confirm: "drain" }));
  });

  it("node config form has only three fields", async () => {
    useAdminStubs();
    renderAt("/admin/node");

    const form = await screen.findByRole("form", { name: "Node configuration" });
    const names = within(form)
      .getAllByRole("textbox")
      .map((field) => field.getAttribute("name"))
      .sort();
    expect(names).toEqual(["default_profile", "degradation_mode", "rate_limit"]);
    expect(within(form).getByText("applies after restart")).toBeInTheDocument();
  });

  it("status and scheduler cards render", async () => {
    useAdminStubs();
    renderAt("/admin/node");
    expect(await screen.findByText("running")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });
});

describe("admin cache", () => {
  it("cache view renders", async () => {
    useAdminStubs();
    renderAt("/admin/cache");
    expect(await screen.findByRole("heading", { name: "Cache" })).toBeInTheDocument();
    expect(await screen.findByText("42")).toBeInTheDocument();
    expect(screen.getByText("0.93")).toBeInTheDocument();
  });
});

describe("admin domains", () => {
  it("admin domain view lists all orgs", async () => {
    useAdminStubs();
    renderAt("/admin/domains");
    expect(await screen.findByText("a.example.test")).toBeInTheDocument();
    expect(screen.getByText("b.example.test")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("issued")).toBeInTheDocument();
    expect(screen.getByText("none")).toBeInTheDocument();
  });
});

describe("admin instance settings", () => {
  it("sso-only toggle disabled without provider", async () => {
    useAdminStubs();
    renderAt("/admin/settings");
    const sso = await screen.findByRole("switch", { name: "Disable password login (SSO only)" });
    expect(sso).toBeDisabled();
  });

  it("require 2fa toggle saves", async () => {
    useAdminStubs();
    const put = vi.fn();
    server.use(
      http.put("/api/admin/settings", async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        put(body);
        return HttpResponse.json({ ...settings, require_2fa: true });
      }),
    );
    renderAt("/admin/settings");

    await userEvent.click(await screen.findByRole("switch", { name: "Require 2FA for all users" }));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(expect.objectContaining({ require_2fa: true })));
  });

  it("client secret is write-only and shows set badge", async () => {
    useAdminStubs();
    server.use(
      http.get("/api/admin/settings", () =>
        HttpResponse.json({
          ...settings,
          providers: [{ ...settings.providers[0], enabled: true, client_id: "gh", client_secret_set: true }, ...settings.providers.slice(1)],
        }),
      ),
    );
    renderAt("/admin/settings");
    expect(await screen.findByText("Secret set")).toBeInTheDocument();
    const secret = screen.getByLabelText("GitHub client secret");
    expect(secret).toHaveValue("");
  });

  it("shows field error when server rejects sso-only", async () => {
    useAdminStubs();
    server.use(
      http.get("/api/admin/settings", () =>
        HttpResponse.json({
          ...settings,
          providers: [{ ...settings.providers[0], enabled: true, client_id: "gh", client_secret_set: true }, ...settings.providers.slice(1)],
        }),
      ),
      http.put("/api/admin/settings", () =>
        HttpResponse.json(
          { error: { code: "invalid", message: "invalid", details: { fields: { password_login_disabled: "Configure an SSO provider first." } } } },
          { status: 422 },
        ),
      ),
    );
    renderAt("/admin/settings");
    await userEvent.click(await screen.findByRole("switch", { name: "Disable password login (SSO only)" }));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Configure an SSO provider first.")).toBeInTheDocument();
  });
});

describe("admin pages copy", () => {
  it.each(["/admin/node", "/admin/cache", "/admin/domains", "/admin/settings"])("no plan or billing UI on %s", async (path) => {
    useAdminStubs();
    renderAt(path);
    await waitFor(() => expect(document.querySelectorAll('[aria-busy="true"]').length).toBe(0));
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\bplan\b/i);
    expect(text).not.toMatch(/upgrade/i);
    expect(text).not.toMatch(/billing/i);
  });
});
