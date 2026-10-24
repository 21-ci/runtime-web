import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { AuditPage } from "./audit-page";

const entry = (id: string, userId: string, name: string, action: string) => ({
  id,
  at: 1_700_000_000_000,
  actor: { user_id: userId, name, email: `${name.toLowerCase()}@example.test` },
  as_instance_admin: false,
  org: { id: "org_1", slug: "acme" },
  action,
  target: "hello",
  detail: null,
});

describe("AuditPage", () => {
  it("audit page filters by actor", async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    server.use(
      http.get("/api/orgs/acme/audit", ({ request }) => {
        const actor = new URL(request.url).searchParams.get("actor") ?? "";
        seen.push(actor);
        const all = [entry("aud_1", "usr_1", "Ada", "app.create"), entry("aud_2", "usr_2", "Grace", "member.role")];
        const items = actor ? all.filter((e) => e.actor.user_id === actor) : all;
        return HttpResponse.json({ items, next_cursor: null });
      }),
    );
    render(
      <QueryClientProvider client={createQueryClient()}>
        <AuditPage org="acme" />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("member.role")).toBeInTheDocument();
    expect(screen.getByText("app.create")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Actor user ID"), "usr_2");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    await waitFor(() => expect(seen).toContain("usr_2"));
    expect(await screen.findByText("member.role")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("app.create")).toBeNull());
  });
});
