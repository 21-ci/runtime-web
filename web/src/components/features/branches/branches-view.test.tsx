import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { BranchesView } from "./branches-view";
import type { Branch, Switch } from "./use-branches";

const branch: Branch = {
  name: "staging",
  slug: "hello-br-staging",
  url: "https://hello-br-staging.apps.test/",
  build_state: "ready",
  live_version: 4,
  digest: "sha256:abcdef0123456789ffff",
  expires_at: null,
};

function sw(over: Partial<Switch> = {}): Switch {
  return {
    id: "swt_1", kind: "switch", state: "draining", from_version: 1, to_version: 2,
    source: { version: 4, digest: "sha256:abc" }, inflight_old: 0, drain_deadline: null, interrupted: false,
    error: null, warnings: [], pending_migrations: null, dry_run: false, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000,
    ...over,
  };
}

type Opts = { role?: "owner" | "member"; branches?: Branch[]; history?: Switch[]; preflight?: Partial<Switch>; preflightStatus?: number; statuses?: Switch[] };

function setup(o: Opts = {}) {
  const state = { bodies: [] as unknown[], ifMatch: [] as string[], rollback: [] as string[], statusReads: 0 };
  const statuses = o.statuses ?? [sw()];
  const role = o.role ?? "owner";
  server.use(
    http.get("/api/me", () => HttpResponse.json({ user: { id: "usr_1", instance_admin: false } })),
    http.get("/api/orgs", () => HttpResponse.json({ items: [{ id: "org_1", slug: "acme", name: "Acme", created_at: 1, role }] })),
    http.get("/api/orgs/:org/projects", () => HttpResponse.json({ items: [{ slug: "web", name: "Web", role: "viewer", environments: [] }] })),
    http.get("/api/orgs/:org/apps/:app", () => HttpResponse.json({ slug: "hello", name: "Hello", project: "web", live_version: 1, etag: '"etag-1"' })),
    http.get("/api/orgs/:org/apps/:app/branches", () => HttpResponse.json({ items: o.branches ?? [branch] })),
    http.get("/api/orgs/:org/apps/:app/switches", () => HttpResponse.json({ items: o.history ?? [], next_cursor: null })),
    http.get("/api/orgs/:org/apps/:app/switches/:id", () => {
      const s = statuses[Math.min(state.statusReads, statuses.length - 1)];
      state.statusReads++;
      return HttpResponse.json(s);
    }),
    http.post("/api/orgs/:org/apps/:app/switch", async ({ request }) => {
      const body = (await request.json()) as { dry_run?: boolean };
      state.bodies.push(body);
      state.ifMatch.push(request.headers.get("If-Match") ?? "");
      if (body.dry_run) {
        if (o.preflightStatus) return HttpResponse.json({ error: { code: "not_a_branch", message: "no" } }, { status: o.preflightStatus });
        return HttpResponse.json(sw({ id: null, state: "preparing", dry_run: true, to_version: null, inflight_old: 2, ...o.preflight }));
      }
      return HttpResponse.json(sw(), { status: 202 });
    }),
    http.post("/api/orgs/:org/apps/:app/switches/:id/rollback", ({ params, request }) => {
      state.rollback.push(`${String(params.id)} ${request.headers.get("If-Match") ?? ""}`);
      return HttpResponse.json(sw({ id: "swt_2", kind: "rollback", from_version: 2, to_version: 1 }), { status: 202 });
    }),
  );
  return state;
}

function view() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <BranchesView org="acme" app="hello" />
    </QueryClientProvider>,
  );
}

async function openDialog() {
  fireEvent.click(await screen.findByRole("button", { name: "Switch to branch staging" }));
  return screen.findByRole("dialog");
}

describe("BranchesView", () => {
  afterEach(() => cleanup());

  it("lists URL, build state, short SHA and expiry", async () => {
    setup({ branches: [branch, { ...branch, name: "next", slug: "hello-br-next", url: "https://hello-br-next.apps.test/", build_state: "building", digest: null, live_version: null, expires_at: 1_800_000_000_000 }] });
    view();
    const link = await screen.findByRole("link", { name: "https://hello-br-staging.apps.test/" });
    expect(link).toHaveAttribute("href", branch.url);
    expect(screen.getByText("abcdef012345")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Building")).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument();
    expect(screen.getByText("None")).toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    setup({ branches: [] });
    view();
    expect(await screen.findByText("No branches yet")).toBeInTheDocument();
  });

  it("hides switch and rollback from a role that cannot deploy", async () => {
    setup({ role: "member", history: [sw({ state: "completed" })] });
    view();
    await screen.findByText("hello-br-staging");
    await screen.findByText("Switch history");
    await screen.findByText("v1 to v2");
    expect(screen.queryByRole("button", { name: "Switch to branch staging" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Roll back to version 1" })).toBeNull();
  });

  it("offers no switch for a branch without a live ready build", async () => {
    setup({ branches: [{ ...branch, live_version: null }] });
    view();
    expect(await screen.findByRole("button", { name: "Switch to branch staging" })).toBeDisabled();
  });

  it("preflight shows names, running tasks and the migration state, and writes nothing", async () => {
    const state = setup({
      preflight: {
        warnings: [
          { code: "env_missing_on_parent", names: ["API_TOKEN", "DB_PASSWORD"] },
          { code: "triggers_differ", names: ["cron"] },
          { code: "future_code", names: [] },
        ],
      },
    });
    view();
    const dialog = within(await openDialog());
    expect(await dialog.findByText("API_TOKEN")).toBeInTheDocument();
    expect(dialog.getByText("DB_PASSWORD")).toBeInTheDocument();
    expect(dialog.getByText("cron")).toBeInTheDocument();
    expect(dialog.getByText("2")).toBeInTheDocument();
    expect(dialog.getByText("Not reported by this runtime")).toBeInTheDocument();
    expect(dialog.getByText("Runtime warning: future_code")).toBeInTheDocument();
    expect(state.bodies).toEqual([{ branch: "staging", dry_run: true }]);
  });

  it("lists pending migrations when the runtime reports them", async () => {
    setup({ preflight: { pending_migrations: ["0007_add_index"] } });
    view();
    const dialog = within(await openDialog());
    expect(await dialog.findByText("0007_add_index")).toBeInTheDocument();
  });

  it("a failed preflight blocks the switch and offers a retry", async () => {
    setup({ preflightStatus: 409 });
    view();
    const dialog = within(await openDialog());
    expect(await dialog.findByText("The check could not finish, so nothing changed.")).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Switch" })).toBeDisabled();
  });

  it("switches with If-Match and follows progress to completion", async () => {
    const state = setup({
      statuses: [sw({ inflight_old: 3, drain_deadline: 1_800_000_000_000 }), sw({ state: "completed", inflight_old: 0 })],
    });
    view();
    const dialog = within(await openDialog());
    await dialog.findByText("Not reported by this runtime");
    fireEvent.click(dialog.getByRole("checkbox"));
    fireEvent.click(dialog.getByRole("button", { name: "Switch" }));
    expect(await dialog.findByText("3 tasks of v1 still running")).toBeInTheDocument();
    expect(state.bodies[1]).toEqual({ branch: "staging", close_sockets: true });
    expect(state.ifMatch[1]).toBe('"etag-1"');
    await waitFor(() => expect(dialog.getByText("Completed")).toBeInTheDocument(), { timeout: 4000 });
    const reads = state.statusReads;
    await new Promise((r) => setTimeout(r, 2200));
    expect(state.statusReads).toBe(reads);
  }, 10_000);

  it("shows why a switch failed", async () => {
    setup({ statuses: [sw({ state: "failed", error: "interrupted", interrupted: true })] });
    view();
    const dialog = within(await openDialog());
    await dialog.findByText("Not reported by this runtime");
    fireEvent.click(dialog.getByRole("button", { name: "Switch" }));
    expect(await dialog.findByText("Reason: interrupted")).toBeInTheDocument();
    expect(dialog.getByText("The node restarted during this switch.")).toBeInTheDocument();
  });

  it("rolls back only the latest flip, after a confirm", async () => {
    const state = setup({
      history: [
        sw({ id: "swt_9", state: "failed", from_version: 2, to_version: 3 }),
        sw({ id: "swt_8", state: "completed", from_version: 1, to_version: 2 }),
        sw({ id: "swt_7", state: "completed", from_version: null, to_version: 1, kind: "promote" }),
      ],
    });
    view();
    const button = await screen.findByRole("button", { name: "Roll back to version 1" });
    expect(screen.getAllByRole("button", { name: /^Roll back to version/ })).toHaveLength(1);
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    const dialog = within(await screen.findByRole("alertdialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Roll back" }));
    await waitFor(() => expect(state.rollback).toEqual(['swt_8 "etag-1"']));
  });
});
