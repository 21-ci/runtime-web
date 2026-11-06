import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { server } from "@/test/msw";
import { createQueryClient } from "@/lib/query";
import { DeploymentsView } from "./deployments-view";

type V = {
  version: number;
  build_state: "pending" | "building" | "ready" | "failed";
  live: boolean;
  source_digest: string;
  failure: null;
  author: { user_id: string; name: string } | null;
  created_at: number;
};

function v(n: number, state: V["build_state"], live: boolean, author: V["author"] = { user_id: "usr_1", name: "Ada" }): V {
  return { version: n, build_state: state, live, source_digest: `d${n}`, failure: null, author, created_at: 1_700_000_000_000 + n };
}

function logLine(seq: number, msg: string) {
  return { seq, ts: seq, level: "info", version: 4, task_id: null, trigger: null, kind: "build", msg, truncated: false };
}

// setup installs handlers for one app. liveVersion is the app's live version.
const sw = (state: string) => ({
  id: "swt_1", kind: "promote", state, from_version: 1, to_version: 2, source: null, inflight_old: 0, drain_deadline: null, interrupted: false,
  error: state === "failed" ? "migration_failed" : null, warnings: [], pending_migrations: null, dry_run: false, created_at: 1, updated_at: 1,
});

function setup(opts: { liveVersion: number; versions: V[]; files?: Record<string, string>; switchEnds?: string; switches?: unknown[]; failSwitches?: boolean }) {
  const state = { ifMatch: "", body: undefined as unknown, rebuilt: false };
  const app = {
    slug: "hello",
    name: "Hello",
    project: "web",
    environment: "dev",
    live_version: opts.liveVersion,
    status: { build_state: "ready", tier: "standard", last_error: null },
    etag: '"etag-1"',
  };
  server.use(
    // The caller is an org owner, so deploy controls (promote, rebuild) are shown.
    http.get("/api/me", () => HttpResponse.json({ user: { id: "usr_1", instance_admin: false } })),
    http.get("/api/orgs", () => HttpResponse.json({ items: [{ id: "org_1", slug: "acme", name: "Acme", created_at: 1, role: "owner" }] })),
    http.get("/api/orgs/:org/projects", () => HttpResponse.json({ items: [] })),
    http.get("/api/orgs/:org/apps/:app", () => HttpResponse.json(app)),
    http.get("/api/orgs/:org/apps/:app/versions", () => HttpResponse.json({ items: opts.versions })),
    http.get("/api/orgs/:org/apps/:app/switches", () =>
      opts.failSwitches ? HttpResponse.json({ error: { code: "internal" } }, { status: 500 }) : HttpResponse.json({ items: opts.switches ?? [], next_cursor: null }),
    ),
    http.get("/api/orgs/:org/apps/:app/events", () => HttpResponse.json({ items: [], next_cursor: null })),
    http.get("/api/orgs/:org/apps/:app/migrations", () => HttpResponse.json({ applied: [], pending_for_latest: [] })),
    http.put("/api/orgs/:org/apps/:app/live", async ({ request }) => {
      state.ifMatch = request.headers.get("If-Match") ?? "";
      state.body = await request.json();
      return HttpResponse.json(sw("preparing"), { status: 202 });
    }),
    http.get("/api/orgs/:org/apps/:app/switches/:id", () => HttpResponse.json(sw(opts.switchEnds ?? "draining"))),
    http.post("/api/orgs/:org/apps/:app/versions/:v/rebuild", () => {
      state.rebuilt = true;
      return HttpResponse.json({ ...v(4, "building", false) }, { status: 202 });
    }),
    http.get("/api/orgs/:org/apps/:app/versions/:v/build-logs", () =>
      HttpResponse.json({
        items: state.rebuilt ? [logLine(10, "rebuilt ok")] : [logLine(1, "old failure")],
      }),
    ),
    http.get("/api/orgs/:org/apps/:app/files", ({ request }) => {
      const ver = new URL(request.url).searchParams.get("version");
      const files =
        ver === "2"
          ? { "a.ts": "x", "b.ts": "new" }
          : { "a.ts": "x", "b.ts": "old", "c.ts": "z" };
      return HttpResponse.json({ version: Number(ver ?? 3), entry: "a.ts", files, read_only: false, kind: "ts" });
    }),
  );
  return state;
}

function renderVersions() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <DeploymentsView org="acme" app="hello" />
    </QueryClientProvider>,
  );
}

describe("DeploymentsView", () => {
  afterEach(() => {
    cleanup();
  });

  it("version author shown", async () => {
    setup({ liveVersion: 1, versions: [v(1, "ready", true, { user_id: "usr_1", name: "Ada" })] });
    renderVersions();
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("shows a rollback inline, between versions, with its duration and no invented author", async () => {
    const rolled = { ...sw("completed"), id: "swt_9", kind: "rollback", from_version: 3, to_version: 2, created_at: 1_700_000_000_002, updated_at: 1_700_000_002_002 };
    setup({ liveVersion: 2, versions: [v(1, "ready", false), v(3, "ready", false), v(2, "ready", true)], switches: [rolled] });
    renderVersions();
    const row = (await screen.findByText("Rolled back v3 to v2")).closest("tr") as HTMLElement;
    expect(row).toHaveTextContent("2.0 s");
    expect(within(row).getAllByText("N/A")).toHaveLength(2);
    expect(screen.queryByText("Switch history")).not.toBeInTheDocument();
  });

  it("a build has no recorded duration and says so", async () => {
    setup({ liveVersion: 1, versions: [v(1, "ready", true)] });
    renderVersions();
    const row = (await screen.findByText("v1")).closest("tr") as HTMLElement;
    expect(within(row).getAllByText("N/A").length).toBeGreaterThan(0);
  });

  it("names the source: commit from meta, console from an author, otherwise CLI or API", async () => {
    setup({ liveVersion: 1, versions: [{ ...v(3, "ready", false), meta: { git: { sha: "abcdef1234" } } } as V, v(2, "ready", false), v(1, "ready", true, null)] });
    renderVersions();
    expect(await screen.findByText("abcdef1")).toBeInTheDocument();
    expect(screen.getByText("Console")).toBeInTheDocument();
    expect(screen.getByText("CLI or API")).toBeInTheDocument();
  });

  it("a version made by a switch names the version it came from; a switch with no source says N/A and why", async () => {
    setup({
      liveVersion: 2,
      versions: [v(2, "ready", true, null), v(1, "ready", false, null)],
      switches: [
        { ...sw("completed"), id: "swt_2", kind: "switch", to_version: 2, source: { version: 7, digest: "d7" }, created_at: 5, updated_at: 6 },
        { ...sw("completed"), to_version: 1, from_version: 2, source: null },
      ],
    });
    renderVersions();
    const named = await screen.findAllByText("Version 7");
    expect(named.length).toBe(2);
    expect(named[0]?.closest("td")).toHaveAttribute("title", "Switched from version 7 of the source app");
    expect(screen.getByText("CLI or API")).toBeInTheDocument();
    expect(document.querySelector('td[title="The runtime did not record where this came from."]')).toHaveTextContent("N/A");
  });

  it("the period filter says when nothing matches", async () => {
    setup({ liveVersion: 1, versions: [v(1, "ready", true)] });
    renderVersions();
    await screen.findByText("v1");
    fireEvent.click(screen.getByRole("radio", { name: "24 h" }));
    expect(await screen.findByText("No deployments match these filters.")).toBeInTheDocument();
    expect(screen.queryByText("v1")).not.toBeInTheDocument();
  });

  it("still lists versions when switches cannot be read, and says so", async () => {
    setup({ liveVersion: 1, versions: [v(1, "ready", true)], failSwitches: true });
    renderVersions();
    expect(await screen.findByText("v1")).toBeInTheDocument();
    expect(await screen.findByText(/Switches and rollbacks could not be loaded/)).toBeInTheDocument();
  });

  it("build log opens in a sheet that can save it as text", async () => {
    setup({ liveVersion: 1, versions: [v(1, "ready", true)] });
    renderVersions();
    fireEvent.click(await screen.findByRole("button", { name: "Build log for version 1" }));
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText("old failure")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Export .txt" })).toBeInTheDocument();
  });

  it("exports through the server route", async () => {
    setup({ liveVersion: 1, versions: [v(1, "ready", true)] });
    renderVersions();
    expect(await screen.findByRole("link", { name: "Export" })).toHaveAttribute("href", "/api/orgs/acme/apps/hello/versions?format=csv");
  });

  it("promote follows the switch until it is committed, and shows a failure with its code", async () => {
    setup({ liveVersion: 1, versions: [v(1, "ready", true), v(2, "ready", false)], switchEnds: "failed" });
    renderVersions();
    const promote = await screen.findByRole("button", { name: "Promote version 2" });
    await waitFor(() => expect(promote).toBeEnabled());
    fireEvent.click(promote);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Promote" }));
    expect(await within(dialog).findByText(/migration_failed/)).toBeInTheDocument();
  });

  it("shows a version still fetching its archive", async () => {
    setup({ liveVersion: 1, versions: [v(1, "ready", true), v(2, "fetching" as V["build_state"], false)] });
    renderVersions();
    expect(await screen.findByText("Fetching")).toBeInTheDocument();
  });

  it("promote calls PUT live", async () => {
    const state = setup({ liveVersion: 1, versions: [v(1, "ready", true), v(2, "ready", false)] });
    renderVersions();
    const promote = await screen.findByRole("button", { name: "Promote version 2" });
    await waitFor(() => expect(promote).toBeEnabled());
    fireEvent.click(promote);

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Promote" }));
    await waitFor(() => expect(state.body).toEqual({ version: 2 }));
    expect(state.ifMatch).toBe('"etag-1"');
  });

  it("rollback dialog names target version", async () => {
    setup({ liveVersion: 3, versions: [v(1, "ready", false), v(2, "ready", false), v(3, "ready", true)] });
    renderVersions();
    const rollback = await screen.findByRole("button", { name: "Roll back to version 2" });
    await waitFor(() => expect(rollback).toBeEnabled());
    fireEvent.click(rollback);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Roll back to version 2?");
  });

  it("failed version cannot be promoted", async () => {
    setup({ liveVersion: 1, versions: [v(1, "ready", true), v(4, "failed", false)] });
    renderVersions();
    const btn = await screen.findByRole("button", { name: "Promote version 4" });
    expect(btn).toBeDisabled();
  });

  it("rebuild failed version shows new build log", async () => {
    setup({ liveVersion: 1, versions: [v(1, "ready", true), v(4, "failed", false)] });
    renderVersions();
    const rebuild = await screen.findByRole("button", { name: "Rebuild version 4" });
    fireEvent.click(rebuild);
    expect(await screen.findByText("rebuilt ok")).toBeInTheDocument();
    expect(screen.queryByText("old failure")).not.toBeInTheDocument();
  });

  it("diff lists changed files against live", async () => {
    setup({ liveVersion: 3, versions: [v(2, "ready", false), v(3, "ready", true)] });
    renderVersions();
    const diff = await screen.findByRole("button", { name: "Diff version 2 against live" });
    fireEvent.click(diff);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText("b.ts")).toBeInTheDocument());
    expect(within(dialog).getByText("b.ts").closest("li")).toHaveTextContent("changed");
    expect(within(dialog).getByText("c.ts").closest("li")).toHaveTextContent("removed");
    expect(within(dialog).queryByText("a.ts")).not.toBeInTheDocument();
  });
});
