import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { SecurityPage } from "./security-page";

// jsdom has no canvas, so the QR encoder is stubbed. The page only needs a data URL to render.
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,UVI=") },
}));

const OTPAUTH = "otpauth://totp/Runtime%20Web:ada@example.test?secret=JBSWY3DPEHPK3PXP&issuer=Runtime%20Web";
const CODES = ["aaaaa-bbbbb", "ccccc-ddddd", "eeeee-fffff"];

const me = {
  user: {
    id: "usr_1",
    email: "ada@example.test",
    name: "Ada",
    instance_admin: false,
    must_change_password: false,
    disabled: false,
    totp_enabled: false,
    created_at: 1,
  },
  csrf: "csrf-1",
  orgs: [],
  policy: { require_2fa: false, password_login_disabled: false },
  mfa_enrollment_required: false,
};

function renderPage() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <SecurityPage />
    </QueryClientProvider>,
  );
}

describe("SecurityPage", () => {
  it("security page lists sessions and revokes", async () => {
    const user = userEvent.setup();
    let sessions = [
      { id: "s_current", ip: "127.0.0.1", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:120.0) Gecko/20100101 Firefox/120.0", created_at: 1, last_seen_at: 2, current: true },
      { id: "s_other", ip: "10.0.0.2", ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", created_at: 1, last_seen_at: 2, current: false },
    ];
    server.use(
      http.get("/api/me", () => HttpResponse.json(me)),
      http.get("/api/me/sessions", () => HttpResponse.json({ items: sessions })),
      http.get("/api/me/logins", () =>
        HttpResponse.json({
          items: [{ id: "l_1", at: 1_700_000_000_000, ip: "127.0.0.1", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:120.0) Gecko/20100101 Firefox/120.0", method: "password", result: "ok" }],
        }),
      ),
      http.delete("/api/me/sessions/:id", ({ params }) => {
        sessions = sessions.filter((s) => s.id !== params.id);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage();

    expect(await screen.findByText("Chrome on Linux")).toBeInTheDocument();
    expect(screen.getByText("This session")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Login history" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Revoke session Chrome on Linux" }));
    await waitFor(() => expect(screen.queryByText("Chrome on Linux")).toBeNull());
    expect(within(screen.getByRole("list", { name: "Sessions" })).getByText("Firefox on macOS")).toBeInTheDocument();
  });

  it("2fa enroll shows QR then recovery codes once", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/me", () => HttpResponse.json(me)),
      http.get("/api/me/sessions", () => HttpResponse.json({ items: [] })),
      http.get("/api/me/logins", () => HttpResponse.json({ items: [] })),
      http.post("/api/me/totp/enroll", async ({ request }) => {
        const body = (await request.json()) as { password: string };
        if (body.password !== "correct-horse") {
          return HttpResponse.json({ error: { code: "invalid_credentials", message: "Wrong password." } }, { status: 401 });
        }
        return HttpResponse.json({ otpauth_url: OTPAUTH });
      }),
      http.post("/api/me/totp/confirm", () => HttpResponse.json({ recovery_codes: CODES })),
    );
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Set up two-factor authentication" }));

    // Step zero: the password is required before the secret is issued.
    await user.type(screen.getByLabelText("Current password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Wrong password. Try again.")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "QR code for your authenticator app" })).toBeNull();

    await user.clear(screen.getByLabelText("Current password"));
    await user.type(screen.getByLabelText("Current password"), "correct-horse");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    // Step one: the QR code and the manual secret, no codes yet.
    expect(await screen.findByRole("img", { name: "QR code for your authenticator app" })).toBeInTheDocument();
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    expect(screen.queryByText(CODES[0])).toBeNull();

    await user.type(screen.getByLabelText("Authentication code"), "123456");
    await user.click(screen.getByRole("button", { name: "Turn on 2FA" }));

    // Step two: the recovery codes appear once, with download and print actions.
    expect(await screen.findByText(CODES[0])).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download recovery codes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print recovery codes" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "I have saved my recovery codes" }));
    await waitFor(() => expect(screen.queryByText(CODES[0])).toBeNull());
  });
  it("linked sign-in lists providers, starts a link, and reports identity_taken", async () => {
    const user = userEvent.setup();
    const linkBodies: unknown[] = [];
    server.use(
      http.get("/api/me", () => HttpResponse.json(me)),
      http.get("/api/me/sessions", () => HttpResponse.json({ items: [] })),
      http.get("/api/me/logins", () => HttpResponse.json({ items: [] })),
      http.get("/api/auth/providers", () =>
        HttpResponse.json({
          password_login_disabled: false,
          providers: [
            { id: "github", name: "GitHub" },
            { id: "google", name: "Google" },
          ],
        }),
      ),
      http.post("/api/me/oauth/:provider/link", async ({ request, params }) => {
        linkBodies.push({ provider: params.provider, body: await request.json() });
        if (params.provider === "google") {
          return HttpResponse.json({ error: { code: "identity_taken", message: "taken" } }, { status: 409 });
        }
        return HttpResponse.json({ location: "https://github.example.test/login/oauth" });
      }),
    );
    renderPage();

    const section = await screen.findByRole("region", { name: "Linked sign-in" });
    expect(await within(section).findByText("GitHub")).toBeInTheDocument();
    expect(within(section).getByText("Google")).toBeInTheDocument();

    await user.click(within(section).getByRole("button", { name: "Link Google" }));
    expect(
      await screen.findByText("That account is already linked to another Runtime Web user."),
    ).toBeInTheDocument();

    // A successful start navigates away to the provider, so the button stays disabled here.
    await user.click(within(section).getByRole("button", { name: "Link GitHub" }));
    await waitFor(() => expect(linkBodies).toContainEqual({ provider: "github", body: {} }));
  });

  it("linked sign-in shows identity_taken after the callback redirect", async () => {
    window.history.replaceState(null, "", "/me/security?error=identity_taken");
    server.use(
      http.get("/api/me", () => HttpResponse.json(me)),
      http.get("/api/me/sessions", () => HttpResponse.json({ items: [] })),
      http.get("/api/me/logins", () => HttpResponse.json({ items: [] })),
      http.get("/api/auth/providers", () =>
        HttpResponse.json({ password_login_disabled: false, providers: [{ id: "github", name: "GitHub" }] }),
      ),
    );
    renderPage();

    expect(
      await screen.findByText("That account is already linked to another Runtime Web user."),
    ).toBeInTheDocument();
    window.history.replaceState(null, "", "/");
  });
});
