import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { server } from "@/test/msw";
import { renderAt } from "@/test/render";

// Routes are code-split, so the first render of a page can take longer than the 1 s default
// under a parallel test run.
configure({ asyncUtilTimeout: 3000 });
vi.setConfig({ testTimeout: 15_000 });

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

// stubAll answers every admin read the four pages make.
function stubAll() {
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
    stubAll();
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
    stubAll();
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
    stubAll();
    renderAt("/admin/node");
    expect(await screen.findByText("running")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });
});

describe("admin cache", () => {
  it("cache view renders", async () => {
    stubAll();
    renderAt("/admin/cache");
    expect(await screen.findByRole("heading", { name: "Cache" })).toBeInTheDocument();
    expect(await screen.findByText("42")).toBeInTheDocument();
    expect(screen.getByText("0.93")).toBeInTheDocument();
  });
});

describe("admin domains", () => {
  it("admin domain view lists all orgs", async () => {
    stubAll();
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
    stubAll();
    renderAt("/admin/settings");
    const sso = await screen.findByRole("switch", { name: "Disable password login (SSO only)" });
    expect(sso).toBeDisabled();
  });

  it("require 2fa toggle saves", async () => {
    stubAll();
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
    stubAll();
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
    stubAll();
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
    stubAll();
    renderAt(path);
    await waitFor(() => expect(document.querySelectorAll('[aria-busy="true"]').length).toBe(0));
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\bplan\b/i);
    expect(text).not.toMatch(/upgrade/i);
    expect(text).not.toMatch(/billing/i);
  });
});
