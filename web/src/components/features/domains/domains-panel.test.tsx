import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setLanguage } from "@/lib/i18n";
import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { DomainsPanel, type Domain } from "./domains-panel";

const TOKEN = "0123456789abcdef0123456789abcdef";

function domain(overrides: Partial<Domain>): Domain {
  return {
    id: "dom_1",
    host: "www.example.com",
    app: "hello",
    status: "pending",
    txt_name: "_rtweb.www.example.com",
    txt_value: TOKEN,
    cname_target: "router.rtweb.test",
    last_checked_at: null,
    verified_at: null,
    cert_status: "none",
    cert_not_after: null,
    cert_error: null,
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}

function renderPanel() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <DomainsPanel org="acme" app="hello" />
    </QueryClientProvider>,
  );
}

describe("DomainsPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("domain pending shows TXT record to copy", async () => {
    const user = userEvent.setup();
    // userEvent.setup() installs its own clipboard stub, so the spy is attached after it.
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    server.use(http.get("/api/orgs/acme/apps/hello/domains", () => HttpResponse.json({ items: [domain({})] })));
    renderPanel();

    expect(await screen.findByText("_rtweb.www.example.com")).toBeInTheDocument();
    expect(screen.getByText(TOKEN)).toBeInTheDocument();
    expect(screen.getByText("router.rtweb.test")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy TXT name" }));
    expect(writeText).toHaveBeenCalledWith("_rtweb.www.example.com");
    await user.click(screen.getByRole("button", { name: "Copy TXT value" }));
    expect(writeText).toHaveBeenCalledWith(TOKEN);
  });

  it("domain tab says TXT must stay", async () => {
    server.use(http.get("/api/orgs/acme/apps/hello/domains", () => HttpResponse.json({ items: [domain({})] })));
    renderPanel();

    expect(await screen.findByText(/Keep the TXT record; removing it deactivates the domain\./)).toBeInTheDocument();
  });

  it("domain shows cert status", async () => {
    server.use(
      http.get("/api/orgs/acme/apps/hello/domains", () =>
        HttpResponse.json({
          items: [
            domain({
              status: "active",
              verified_at: 1,
              cert_status: "issued",
              cert_not_after: Date.UTC(2027, 0, 15),
            }),
          ],
        }),
      ),
    );
    renderPanel();

    expect(await screen.findByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Certificate issued")).toBeInTheDocument();
    expect(screen.getByText(/Expires/)).toBeInTheDocument();
  });

  it("verify button re-checks a pending domain", async () => {
    const user = userEvent.setup();
    let verified = false;
    server.use(
      http.get("/api/orgs/acme/apps/hello/domains", () =>
        HttpResponse.json({ items: [domain({ status: verified ? "active" : "pending" })] }),
      ),
      http.post("/api/orgs/acme/apps/hello/domains/dom_1/verify", () => {
        verified = true;
        return HttpResponse.json(domain({ status: "active", verified_at: 2 }));
      }),
    );
    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Verify www.example.com" }));
    expect(await screen.findByText("Active")).toBeInTheDocument();
  });

  it("renders in the selected language", async () => {
    await setLanguage("ru");
    try {
      server.use(http.get("/api/orgs/acme/apps/hello/domains", () => HttpResponse.json({ items: [domain({})] })));
      renderPanel();

      expect(await screen.findByText("Свои домены")).toBeInTheDocument();
      expect(await screen.findByRole("button", { name: "Скопировать имя TXT" })).toBeInTheDocument();
    } finally {
      await setLanguage("en");
    }
  });
});
