import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { server } from "@/test/msw";
import { createQueryClient } from "@/lib/query";
import { VersionsView } from "./versions-view";

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
function setup(opts: { liveVersion: number; versions: V[]; files?: Record<string, string> }) {
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
    http.get("/api/orgs/:org/apps/:app", () => HttpResponse.json(app)),
    http.get("/api/orgs/:org/apps/:app/versions", () => HttpResponse.json({ items: opts.versions })),
    http.put("/api/orgs/:org/apps/:app/live", async ({ request }) => {
      state.ifMatch = request.headers.get("If-Match") ?? "";
      state.body = await request.json();
      return HttpResponse.json({ live_version: 2, etag: '"etag-2"' }, { headers: { ETag: '"etag-2"' } });
    }),
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
      <VersionsView org="acme" app="hello" />
    </QueryClientProvider>,
  );
}

describe("VersionsView", () => {
  afterEach(() => {
    cleanup();
  });

  it("version author shown", async () => {
    setup({ liveVersion: 1, versions: [v(1, "ready", true, { user_id: "usr_1", name: "Ada" })] });
    renderVersions();
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
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
