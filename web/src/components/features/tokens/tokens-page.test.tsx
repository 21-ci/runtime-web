import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { TokensPage } from "./tokens-page";

const SECRET = "rtw_secret_abc123";

function renderPage(role: "owner" | "admin" | "member") {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <TokensPage org="acme" role={role} />
    </QueryClientProvider>,
  );
}

function baseHandlers(created: { body?: unknown }) {
  server.use(
    http.get("/api/orgs/acme/tokens", () => HttpResponse.json({ items: [] })),
    http.get("/api/orgs/acme/apps", () => HttpResponse.json({ items: [], next_cursor: null })),
    http.post("/api/orgs/acme/tokens", async ({ request }) => {
      created.body = await request.json();
      return HttpResponse.json(
        {
          token: {
            id: "tok_1",
            name: "CI",
            scopes: ["services:read"],
            apps: [],
            created_by: { id: "usr_1", name: "Ada" },
            created_at: 1,
            expires_at: null,
            last_used_at: null,
          },
          secret: SECRET,
        },
        { status: 201 },
      );
    }),
  );
}

describe("TokensPage", () => {
  it("token created is shown once then hidden", async () => {
    const user = userEvent.setup();
    const created: { body?: unknown } = {};
    baseHandlers(created);
    renderPage("owner");

    await user.click(await screen.findByRole("button", { name: "New token" }));
    await user.type(screen.getByLabelText("Name"), "CI");
    await user.click(screen.getByRole("checkbox", { name: "services:read" }));
    await user.click(screen.getByRole("button", { name: "Create token" }));

    // The secret is visible once, in the dialog that follows creation.
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    expect(created.body).toEqual({ name: "CI", scopes: ["services:read"], apps: [], expires_at: null });

    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByText(SECRET)).toBeNull());
    expect(document.body.textContent ?? "").not.toContain(SECRET);
  });

  it("token form limits scopes to role", async () => {
    const user = userEvent.setup();
    baseHandlers({});
    renderPage("admin");

    await user.click(await screen.findByRole("button", { name: "New token" }));
    const dialog = await screen.findByRole("dialog");
    // Admins get every scope except keys:write, which is never offered in the UI.
    expect(within(dialog).getByRole("checkbox", { name: "secrets:write" })).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "data:admin" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox", { name: "keys:write" })).toBeNull();
  });

  it("members cannot manage tokens", async () => {
    baseHandlers({});
    renderPage("member");

    expect(await screen.findByText(/owner or admin role/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New token" })).toBeNull();
  });
});
