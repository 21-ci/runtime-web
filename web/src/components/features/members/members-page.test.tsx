import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { MembersPage } from "./members-page";

const members = [
  { user: { id: "usr_1", email: "ada@example.test", name: "Ada" }, role: "owner", grants: {} },
  { user: { id: "usr_2", email: "grace@example.test", name: "Grace" }, role: "member", grants: { web: "developer" } },
];

function renderPage(role: "owner" | "admin") {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MembersPage org="acme" role={role} />
    </QueryClientProvider>,
  );
}

describe("MembersPage", () => {
  it("pending invites can be revoked", async () => {
    const user = userEvent.setup();
    let invites = [
      {
        id: "inv_1",
        email: "linus@example.test",
        org: { slug: "acme", name: "Acme" },
        role: "member",
        created_by: { id: "usr_1", name: "Ada" },
        created_at: 1,
        expires_at: 2,
      },
    ];
    let revoked = "";
    server.use(
      http.get("/api/orgs/acme/members", () => HttpResponse.json({ items: members })),
      http.get("/api/orgs/acme/invites", () => HttpResponse.json({ items: invites })),
      http.delete("/api/orgs/acme/invites/:id", ({ params }) => {
        revoked = String(params.id);
        invites = invites.filter((i) => i.id !== params.id);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage("owner");

    expect(await screen.findByText("linus@example.test")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke invite for linus@example.test" }));
    await user.click(await screen.findByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(revoked).toBe("inv_1"));
    await waitFor(() => expect(screen.queryByText("linus@example.test")).toBeNull());
  });

  it("long member emails truncate with a full-text title", async () => {
    const long = "someone.with.a.very.long.address@a-really-long-company-domain.example.test";
    server.use(
      http.get("/api/orgs/acme/members", () =>
        HttpResponse.json({ items: [{ ...members[1], user: { ...members[1].user, email: long } }] }),
      ),
      http.get("/api/orgs/acme/invites", () => HttpResponse.json({ items: [] })),
    );
    renderPage("owner");

    const email = await screen.findByText(long);
    expect(email).toHaveAttribute("title", long);
    expect(email.className).toContain("truncate");
    expect(email.parentElement?.className).toContain("min-w-0");
  });

  it("owners-only controls hidden for admins", async () => {
    server.use(
      http.get("/api/orgs/acme/members", () => HttpResponse.json({ items: members })),
      http.get("/api/orgs/acme/invites", () => HttpResponse.json({ items: [] })),
    );
    renderPage("admin");

    const ownerRow = (await screen.findByText("ada@example.test")).closest("li");
    expect(ownerRow).not.toBeNull();
    // The owner row is read-only for admins: no role select and no remove action.
    expect(within(ownerRow!).queryByRole("combobox", { name: /role/i })).toBeNull();
    expect(within(ownerRow!).queryByRole("button", { name: /remove/i })).toBeNull();
    // Owner is never offered as a role an admin can assign.
    expect(screen.queryByRole("option", { name: "Owner" })).toBeNull();
    // A regular member row keeps its controls.
    const memberRow = screen.getByText("grace@example.test").closest("li");
    expect(within(memberRow!).getByRole("combobox", { name: /role/i })).toBeInTheDocument();
  });
});
