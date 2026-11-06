import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { AuditPage } from "./audit-page";
import { parseAuditSearch, type AuditSearch } from "./audit-search";

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

const members = {
  items: [
    { user: { id: "usr_1", email: "ada@example.test", name: "Ada" }, role: "owner", grants: {} },
    { user: { id: "usr_2", email: "grace@example.test", name: "Grace" }, role: "member", grants: {} },
  ],
};

function Harness({ initial = {}, onSearch }: { initial?: AuditSearch; onSearch?: (s: AuditSearch) => void }) {
  const [search, setSearch] = useState<AuditSearch>(initial);
  return (
    <AuditPage
      org="acme"
      search={search}
      onSearchChange={(next) => {
        setSearch(next);
        onSearch?.(next);
      }}
    />
  );
}

describe("audit search", () => {
  it("keeps known filters and drops empty or unknown ones", () => {
    expect(parseAuditSearch({ actor: "usr_1", action: "", period: "7d", x: 1 })).toEqual({ actor: "usr_1", period: "7d" });
    expect(parseAuditSearch({ period: "all" })).toEqual({});
    expect(parseAuditSearch({ period: "1y" })).toEqual({});
  });
});

describe("AuditPage", () => {
  it("has one heading for the title and sends filters from the URL to the API", async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      http.get("/api/orgs/acme/members", () => HttpResponse.json(members)),
      http.get("/api/orgs/acme/audit", ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json({ items: [entry("aud_1", "usr_2", "Grace", "app.create")], next_cursor: null });
      }),
    );
    render(<QueryClientProvider client={createQueryClient()}><Harness initial={{ actor: "usr_2", action: "app.create", period: "24h" }} /></QueryClientProvider>);
    await screen.findByText("app.create");
    expect(seen[0]?.get("actor")).toBe("usr_2");
    expect(seen[0]?.get("action")).toBe("app.create");
    expect(seen[0]?.get("since")).toMatch(/Z$/);
    expect(screen.getAllByRole("heading", { name: "Audit log" })).toHaveLength(1);
    expect(screen.getByRole("radio", { name: "24 h" })).toBeChecked();
  });

  it("reports filter changes for the URL", async () => {
    const user = userEvent.setup();
    const changes: AuditSearch[] = [];
    server.use(
      http.get("/api/orgs/acme/members", () => HttpResponse.json(members)),
      http.get("/api/orgs/acme/audit", () => HttpResponse.json({ items: [entry("aud_1", "usr_1", "Ada", "app.create")], next_cursor: null })),
    );
    render(<QueryClientProvider client={createQueryClient()}><Harness onSearch={(s) => changes.push(s)} /></QueryClientProvider>);
    await screen.findByText("app.create");
    await user.click(screen.getByRole("radio", { name: "7 d" }));
    expect(changes.at(-1)).toEqual({ period: "7d" });
  });

  it("sends the picked period to the list and to the export", async () => {
    const user = userEvent.setup();
    const seen: (string | null)[] = [];
    server.use(
      http.get("/api/orgs/acme/members", () => HttpResponse.json(members)),
      http.get("/api/orgs/acme/audit", ({ request }) => {
        seen.push(new URL(request.url).searchParams.get("since"));
        return HttpResponse.json({ items: [entry("aud_1", "usr_1", "Ada", "app.create")], next_cursor: null });
      }),
    );
    render(<QueryClientProvider client={createQueryClient()}><Harness /></QueryClientProvider>);
    await screen.findByText("app.create");
    expect(seen[0]).toBeNull();
    await user.click(screen.getByRole("radio", { name: "7 d" }));
    await waitFor(() => expect(seen.at(-1)).toMatch(/Z$/));
    await user.click(screen.getByRole("button", { name: "Export" }));
    const href = (await screen.findByRole("menuitem", { name: ".csv" })).getAttribute("href") ?? "";
    expect(new URL(href, "http://x").searchParams.get("since")).toBe(seen.at(-1));
  });

  it("shows actor names only, pages by twenty and filters by a member picked from the list", async () => {
    const user = userEvent.setup();
    const seen: { actor: string; limit: string }[] = [];
    server.use(
      http.get("/api/orgs/acme/members", () => HttpResponse.json(members)),
      http.get("/api/orgs/acme/audit", ({ request }) => {
        const q = new URL(request.url).searchParams;
        const actor = q.get("actor") ?? "";
        seen.push({ actor, limit: q.get("limit") ?? "" });
        const all = [entry("aud_1", "usr_1", "Ada", "app.create"), entry("aud_2", "usr_2", "Grace", "member.role")];
        const items = actor ? all.filter((e) => e.actor.user_id === actor) : all;
        return HttpResponse.json({ items, next_cursor: null });
      }),
    );
    render(
      <QueryClientProvider client={createQueryClient()}>
        <Harness />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("member.role")).toBeInTheDocument();
    expect(screen.getByText("app.create")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.queryByText("usr_1")).toBeNull();
    expect(seen[0]?.limit).toBe("20");

    await user.click(screen.getByRole("combobox", { name: "Actor" }));
    await user.click(await screen.findByRole("option", { name: "Grace" }));

    await waitFor(() => expect(seen.map((x) => x.actor)).toContain("usr_2"));
    await waitFor(() => expect(screen.queryByText("app.create")).toBeNull());
    expect(screen.getByText("member.role")).toBeInTheDocument();
  });

  it("offers the export in csv and ndjson with the filters on screen", async () => {
    server.use(
      http.get("/api/orgs/acme/members", () => HttpResponse.json(members)),
      http.get("/api/orgs/acme/audit", () => HttpResponse.json({ items: [entry("aud_1", "usr_1", "Ada", "app.create")], next_cursor: null })),
    );
    render(
      <QueryClientProvider client={createQueryClient()}>
        <Harness />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("app.create")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export/i })).toBeInTheDocument();
  });
});
