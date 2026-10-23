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
      { id: "s_current", ip: "127.0.0.1", ua: "Firefox on macOS", created_at: 1, last_seen_at: 2, current: true },
      { id: "s_other", ip: "10.0.0.2", ua: "Chrome on Linux", created_at: 1, last_seen_at: 2, current: false },
    ];
    server.use(
      http.get("/api/me", () => HttpResponse.json(me)),
      http.get("/api/me/sessions", () => HttpResponse.json({ items: sessions })),
      http.get("/api/me/logins", () =>
        HttpResponse.json({
          items: [{ id: "l_1", at: 1_700_000_000_000, ip: "127.0.0.1", ua: "Firefox on macOS", method: "password", result: "ok" }],
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
      http.post("/api/me/totp/enroll", () => HttpResponse.json({ otpauth_url: OTPAUTH })),
      http.post("/api/me/totp/confirm", () => HttpResponse.json({ recovery_codes: CODES })),
    );
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Set up two-factor authentication" }));

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
});
