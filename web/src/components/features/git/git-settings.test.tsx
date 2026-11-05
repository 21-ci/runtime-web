import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { GitSettings } from "./git-settings";
import type { GitLink, GitView } from "./use-git";

const link: GitLink = {
  provider: "github", base_url: "https://github.com", repo: "acme/hello", branch: "main", subdir: null,
  auto_promote: true, paused: false, hook_id: "ghk_1", has_token: true, webhook_url: "https://console.test/api/hooks/git/ghk_1",
};

function setup(o: { role?: "owner" | "member"; view?: GitView } = {}) {
  const state = { created: [] as unknown[], rules: [] as unknown[], patches: [] as unknown[], reads: 0 };
  server.use(
    http.get("/api/me", () => HttpResponse.json({ user: { id: "usr_1", instance_admin: false } })),
    http.get("/api/orgs", () => HttpResponse.json({ items: [{ id: "org_1", slug: "acme", name: "Acme", created_at: 1, role: o.role ?? "owner" }] })),
    http.get("/api/orgs/:org/projects", () => HttpResponse.json({ items: [{ slug: "web", name: "Web", role: "developer", environments: [] }] })),
    http.get("/api/orgs/:org/apps/:app", () => HttpResponse.json({ slug: "hello", name: "Hello", project: "web", live_version: 1, etag: '"e"' })),
    http.get("/api/orgs/:org/apps/:app/git", () => {
      state.reads++;
      return HttpResponse.json(o.view ?? { link: null, rules: [], deliveries: [] });
    }),
    http.post("/api/orgs/:org/apps/:app/git", async ({ request }) => {
      state.created.push(await request.json());
      return HttpResponse.json({ ...link, hook_secret: "dev-insecure-shown-once" }, { status: 201 });
    }),
    http.patch("/api/orgs/:org/apps/:app/git", async ({ request }) => {
      state.patches.push(await request.json());
      return HttpResponse.json(link);
    }),
    http.put("/api/orgs/:org/apps/:app/git/rules", async ({ request }) => {
      state.rules.push(await request.json());
      return HttpResponse.json({ rules: [] });
    }),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <GitSettings org="acme" app="hello" />
    </QueryClientProvider>,
  );
  return state;
}

afterEach(cleanup);

describe("GitSettings", () => {
  it("creates a link and shows the secret once", async () => {
    const state = setup();
    fireEvent.change(await screen.findByLabelText("Repository"), { target: { value: "acme/hello" } });
    fireEvent.change(screen.getByLabelText("Access token (optional)"), { target: { value: "dev-insecure-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Link repository" }));
    expect(await screen.findByText("dev-insecure-shown-once")).toBeTruthy();
    expect(state.created[0]).toMatchObject({ provider: "github", repo: "acme/hello", branch: "main", token: "dev-insecure-token" });
  });

  it("shows the paused badge and resumes the link", async () => {
    const state = setup({ view: { link: { ...link, paused: true }, rules: [], deliveries: [] } });
    expect(await screen.findByText("Paused")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(state.patches).toEqual([{ paused: false }]));
  });

  it("edits rules with auto switch off by default and warns when it is on", async () => {
    const state = setup({ view: { link, rules: [{ ref_pattern: "feature/*", branch_name: "staging", auto_switch: false, paused: true }], deliveries: [] } });
    expect(await screen.findByText("Paused")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    const patterns = screen.getAllByLabelText("Git branch pattern");
    fireEvent.change(patterns[1]!, { target: { value: "rel/*" } });
    fireEvent.change(screen.getAllByLabelText("App branch")[1]!, { target: { value: "rel" } });
    expect(screen.queryByText(/with no review/)).toBeNull();
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Auto switch" })[1]!);
    expect(screen.getByText(/with no review/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    await waitFor(() => expect(state.rules).toHaveLength(1));
    expect(state.rules[0]).toEqual({
      rules: [
        { ref_pattern: "feature/*", branch_name: "staging", auto_switch: false, paused: true },
        { ref_pattern: "rel/*", branch_name: "rel", auto_switch: true, paused: false },
      ],
    });
  });

  it("renders a commit message-free delivery list with its stable error code", async () => {
    setup({ view: { link, rules: [], deliveries: [{ ref: "refs/heads/main", sha: "a".repeat(40), head_sha: null, state: "failed", version: null, error: "head_check_failed", target_branch: null, received_at: 1 }] } });
    expect(await screen.findByText("head_check_failed")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("reads nothing and shows nothing to someone who cannot manage it", async () => {
    const state = setup({ role: "member" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Git deploys")).toBeNull();
    expect(state.reads).toBe(0);
  });
});
