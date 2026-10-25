import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setCsrfToken } from "@/lib/api";
import { apiError, defaultBranding, server } from "@/test/msw";
import { renderAt } from "@/test/render";
import { me, useShellHandlers } from "@/test/shell-fixtures";

import { contrast, deriveAccent } from "./color";
import { previewVars } from "./preview";

configure({ asyncUtilTimeout: 4000 });
vi.setConfig({ testTimeout: 15_000 });

const adminMe = { ...me, user: { ...me.user, instance_admin: true } };
const settings = {
  public_url: "https://console.example.test",
  require_2fa: false,
  password_login_disabled: false,
  providers: [],
};

const acme = {
  ...defaultBranding,
  product_name: "Acme Cloud",
  accent: "#7c3aed",
  logo_light_url: "/api/branding/assets/logo-light?v=abc",
  login_headline: "Welcome to Acme",
  login_subtitle: "Use your Acme account.",
  support_url: "https://help.acme.test",
  support_email: "help@acme.test",
  etag: "brand1",
};

function useAdmin() {
  useShellHandlers();
  server.use(
    http.get("/api/me", () => HttpResponse.json(adminMe)),
    http.get("/api/admin/settings", () => HttpResponse.json(settings)),
  );
}

beforeEach(() => {
  setCsrfToken(null);
  localStorage.clear();
});

describe("branding on public pages", () => {
  it("login shows the brand logo, headline, subtitle and Powered by", async () => {
    server.use(http.get("/api/branding", () => HttpResponse.json(acme)));
    renderAt("/login");
    expect(await screen.findByRole("heading", { name: "Welcome to Acme" })).toBeInTheDocument();
    expect(screen.getByText("Use your Acme account.")).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "Acme Cloud" })[0]).toHaveAttribute("src", acme.logo_light_url);
    expect(screen.getByText(/Powered by Runtime Web/)).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("Acme Cloud"));
  });

  it("hides Powered by when the admin turned it off, and defaults when unbranded", async () => {
    server.use(http.get("/api/branding", () => HttpResponse.json({ ...acme, hide_powered_by: true })));
    renderAt("/login");
    expect(await screen.findByText("Acme Cloud")).toBeInTheDocument();
    expect(screen.queryByText(/Powered by/)).not.toBeInTheDocument();
  });

  it("unbranded login keeps the default copy", async () => {
    renderAt("/login");
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(screen.getByText("Runtime Console")).toBeInTheDocument();
    expect(screen.queryByText(/Powered by/)).not.toBeInTheDocument();
  });
});

describe("branding in the shell", () => {
  it("shows the sidebar brand and help links in the account menu", async () => {
    useShellHandlers();
    server.use(http.get("/api/branding", () => HttpResponse.json({ ...acme, logo_light_url: null })));
    renderAt("/acme");
    expect(await screen.findByTestId("sidebar-brand")).toHaveTextContent("Acme Cloud");
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(await screen.findByRole("menuitem", { name: "Get help" })).toHaveAttribute("href", "https://help.acme.test");
    expect(screen.getByRole("menuitem", { name: "Email support" })).toHaveAttribute("href", "mailto:help@acme.test");
  });
});

describe("admin branding editor", () => {
  it("saves the fields with If-Match", async () => {
    useAdmin();
    let ifMatch: string | null = null;
    let body: unknown = null;
    server.use(
      http.put("/api/admin/branding", async ({ request }) => {
        ifMatch = request.headers.get("if-match");
        body = await request.json();
        return HttpResponse.json({ ...defaultBranding, product_name: "Acme Cloud", etag: "brand2" });
      }),
    );
    renderAt("/admin/settings");
    const name = await screen.findByLabelText("Product name");
    await userEvent.type(name, "Acme Cloud");
    await userEvent.type(screen.getByLabelText("Accent colour"), "#7c3aed");
    await userEvent.click(screen.getByRole("radio", { name: "Round" }));
    await userEvent.click(screen.getByRole("button", { name: "Save branding" }));
    await waitFor(() => expect(ifMatch).toBe('"brand0"'));
    expect(body).toMatchObject({ product_name: "Acme Cloud", accent: "#7c3aed", radius: "round" });
    expect(await screen.findByText("Branding saved.")).toBeInTheDocument();
    expect(screen.getAllByText(/Sign in to Acme Cloud/).length).toBeGreaterThan(0);
  });

  it("warns when the accent fails AA and shows the adjusted shade", async () => {
    useAdmin();
    renderAt("/admin/settings");
    await userEvent.type(await screen.findByLabelText("Accent colour"), "#ffee00");
    const warning = await screen.findByText(/below the 4.5:1 WCAG AA/);
    expect(warning).toHaveTextContent(deriveAccent("#ffee00").light.accent);
  });

  it("rejects a malformed hex before saving", async () => {
    useAdmin();
    const put = vi.fn();
    server.use(http.put("/api/admin/branding", () => {
      put();
      return HttpResponse.json(defaultBranding);
    }));
    renderAt("/admin/settings");
    await userEvent.type(await screen.findByLabelText("Accent colour"), "#12");
    expect(screen.getByText("Use a hex colour like #7c3aed.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save branding" }));
    expect(put).not.toHaveBeenCalled();
  });

  it("shows server field errors and reloads on a stale etag", async () => {
    useAdmin();
    let calls = 0;
    server.use(
      http.put("/api/admin/branding", () => {
        calls += 1;
        return calls === 1
          ? apiError(422, "invalid", "validation failed", { details: { fields: { support_url: "must_be_http_url" } } })
          : apiError(409, "stale", "changed elsewhere");
      }),
    );
    renderAt("/admin/settings");
    await userEvent.type(await screen.findByLabelText("Support URL"), "ftp://x");
    await userEvent.click(screen.getByRole("button", { name: "Save branding" }));
    expect(await screen.findByText("Use an http or https URL.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save branding" }));
    expect(await screen.findByText(/changed by someone else/)).toBeInTheDocument();
  });

  it("uploads a picked image as base64 and a dropped one too", async () => {
    useAdmin();
    const uploads: { kind: string; data: string }[] = [];
    server.use(
      http.put("/api/admin/branding/assets/:kind", async ({ params, request }) => {
        const b = (await request.json()) as { data: string };
        uploads.push({ kind: String(params.kind), data: b.data });
        return HttpResponse.json({ ...defaultBranding, icon_url: "/api/branding/assets/icon?v=1", etag: "brand3" });
      }),
    );
    renderAt("/admin/settings");
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "logo.png", { type: "image/png" });
    await userEvent.upload(await screen.findByLabelText("Logo"), file);
    await waitFor(() => expect(uploads[0]).toEqual({ kind: "logo-light", data: "iVBORw==" }));
    fireEvent.drop(screen.getByTestId("brand-icon-drop"), { dataTransfer: { files: [file] } });
    await waitFor(() => expect(uploads[1]?.kind).toBe("icon"));
    expect(await screen.findByRole("img", { name: "Icon preview" })).toBeInTheDocument();
  });

  it("refuses an oversize file locally and explains an SVG refusal", async () => {
    useAdmin();
    server.use(
      http.put("/api/admin/branding/assets/:kind", () =>
        apiError(422, "invalid", "validation failed", { details: { fields: { data: "svg_active_content" } } }),
      ),
    );
    renderAt("/admin/settings");
    const big = new File([new Uint8Array(512 * 1024 + 1)], "big.png", { type: "image/png" });
    await userEvent.upload(await screen.findByLabelText("Icon"), big);
    expect(await screen.findByText("The image is larger than 512 KB.")).toBeInTheDocument();
    await userEvent.upload(screen.getByLabelText("Icon"), new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }));
    expect(await screen.findByText(/contains scripts/)).toBeInTheDocument();
  });

  it("removes an image and resets everything after confirming", async () => {
    useAdmin();
    let deleted = "";
    let reset = false;
    server.use(
      http.get("/api/branding", () => HttpResponse.json(acme)),
      http.delete("/api/admin/branding/assets/:kind", ({ params }) => {
        deleted = String(params.kind);
        return HttpResponse.json({ ...acme, logo_light_url: null });
      }),
      http.delete("/api/admin/branding", ({ request }) => {
        reset = request.headers.get("if-match") === '"brand1"';
        return HttpResponse.json(defaultBranding);
      }),
    );
    renderAt("/admin/settings");
    await userEvent.click(await screen.findByRole("button", { name: "Remove logo" }));
    await waitFor(() => expect(deleted).toBe("logo-light"));
    await userEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Reset branding" }));
    await waitFor(() => expect(reset).toBe(true));
    expect(await screen.findByText("Branding reset to the defaults.")).toBeInTheDocument();
    expect(screen.getByLabelText("Product name")).toHaveValue("");
  });
});

describe("branding colour helpers", () => {
  it("keeps every derived pair at AA", () => {
    for (const hex of ["#7c3aed", "#ffee00", "#00ff00", "#000000", "#ffffff"]) {
      const d = deriveAccent(hex);
      expect(contrast(d.light.accent, "#ffffff")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(d.light.accent, d.light.onAccent)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(d.dark.accent, "#191919")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(d.dark.accent, d.dark.onAccent)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("maps radius and tint into preview variables", () => {
    const v = previewVars({ accent: "", radius: "sharp", tint: "cool" }, "dark") as Record<string, string>;
    expect(v["--r-md"]).toBe("3px");
    expect(v["--panel"]).toBe("#1e2024");
    expect(v["--accent"]).toBeUndefined();
  });
});
