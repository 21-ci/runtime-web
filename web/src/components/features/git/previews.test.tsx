import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { PreviewsCard, type Preview } from "./previews";

const SHA = "a".repeat(40);
const held: Preview = { pr: 7, sha: SHA, slug: null, url: null, fork: true, held: true, approved_sha: null, approved_with_env: false, created_at: 1, last_deploy_at: null, expires_at: 2 };
const live: Preview = { ...held, pr: 8, fork: false, held: false, slug: "hello-pr-8-abcd1234", url: "https://rt.test/s/hello-pr-8-abcd1234/" };

function setup(role: "owner" | "member" = "owner", grant = "viewer") {
  const state = { approved: [] as unknown[], deleted: [] as string[] };
  server.use(
    http.get("/api/me", () => HttpResponse.json({ user: { id: "usr_1", instance_admin: false } })),
    http.get("/api/orgs", () => HttpResponse.json({ items: [{ id: "org_1", slug: "acme", name: "Acme", created_at: 1, role }] })),
    http.get("/api/orgs/:org/projects", () => HttpResponse.json({ items: [{ slug: "web", name: "Web", role: grant, environments: [] }] })),
    http.get("/api/orgs/:org/apps/:app/previews", () => HttpResponse.json({ items: [held, live] })),
    http.post("/api/orgs/:org/apps/:app/previews/:pr/approve", async ({ request }) => {
      state.approved.push(await request.json());
      return HttpResponse.json({});
    }),
    http.delete("/api/orgs/:org/apps/:app/previews/:pr", ({ params }) => {
      state.deleted.push(String(params.pr));
      return new HttpResponse(null, { status: 204 });
    }),
  );
  render(<QueryClientProvider client={createQueryClient()}><PreviewsCard org="acme" app="hello" project="web" /></QueryClientProvider>);
  return { state };
}

afterEach(cleanup);

describe("PreviewsCard", () => {
  it("approves the exact SHA shown, without env unless asked", async () => {
    const { state } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(new RegExp(SHA))).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Run this commit" }));
    await waitFor(() => expect(state.approved).toEqual([{ sha: SHA, with_env: false }]));
  });

  it("asks before deleting", async () => {
    const { state } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Delete preview 8" }));
    expect(state.deleted).toEqual([]);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(state.deleted).toEqual(["8"]));
  });

  it("a viewer sees the list without any control", async () => {
    setup("member");
    expect(await screen.findByText("#7")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).toBeNull());
  });

});
