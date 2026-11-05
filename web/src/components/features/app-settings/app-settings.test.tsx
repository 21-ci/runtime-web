import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";

import { createQueryClient } from "@/lib/query";
import { apiError, server } from "@/test/msw";

import { AccessSection } from "./access";
import { CallersSection } from "./callers";
import { DangerZone } from "./danger-zone";
import { ExportDataButton } from "./export-data";
import { EgressSection } from "./egress";
import { IngressSection } from "./ingress";
import { LimitsSection } from "./limits";
import { ScalingSection } from "./scaling";
import { StatusPill } from "./status-pill";
import type { AppDetail } from "./api";
import { pickOption } from "@/test/select";

const org = "acme";

function appFixture(over: Partial<AppDetail> = {}): AppDetail {
  return {
    slug: "hello",
    name: "Hello",
    project: "web",
    environment: "dev",
    live_version: 1,
    etag: '"etag-1"',
    runtime: "deno",
    profile: null,
    access: "public",
    url: "https://run.example.test/s/hello/",
    scaling: { min_instances: 1, max_instances: 3 },
    ingress: { methods: ["GET"], path_prefixes: ["/api"], ip_allow: ["10.0.0.0/8"] },
    egress: null,
    call: { allowed_callers: [] },
    status: { build_state: "ready", tier: "standard", last_error: null, inflight: 0, admission: null },
    limits: { requested: { cpu_ms: 100 }, effective: { cpu_ms: 50 }, source: "profile" },
    ...over,
  };
}

function renderWithClient(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("app settings", () => {
  it("access key mode prompts invoke token", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/orgs/acme/tokens", () =>
        HttpResponse.json(
          { token: { id: "tok_1", name: "invoke hello" }, secret: "rt_secret_123" },
          { status: 201 },
        ),
      ),
    );
    renderWithClient(<AccessSection org={org} app={appFixture()} />);

    expect(screen.queryByText(/needs an invoke token/i)).toBeNull();
    await pickOption(user, screen.getByRole("combobox", { name: "Access" }), "Key");
    expect(screen.getByText(/needs an invoke token/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create invoke token" }));
    expect(await screen.findByText("rt_secret_123")).toBeInTheDocument();
    expect(screen.getByText(/shown once/i)).toBeInTheDocument();
  });

  it("ip_allow rejects invalid CIDR client-side", async () => {
    const user = userEvent.setup();
    const patch = vi.fn();
    server.use(
      http.patch("/api/orgs/acme/apps/hello", async () => {
        patch();
        return HttpResponse.json({});
      }),
    );
    renderWithClient(<IngressSection org={org} app={appFixture()} />);

    const rows = screen.getAllByLabelText(/^IP allow \d+$/);
    await user.clear(rows[0]);
    await user.type(rows[0], "10.0.0.0/33");
    await user.click(screen.getByRole("button", { name: "Save ingress" }));

    expect(await screen.findByText(/not a CIDR prefix/i)).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("allowed_callers picker lists org apps", async () => {
    server.use(
      http.get("/api/orgs/acme/apps", () =>
        HttpResponse.json({
          items: [
            { slug: "hello", name: "Hello", project: "web", environment: "dev", live_version: 1, status: { build_state: "ready", tier: "standard", last_error: null } },
            { slug: "billing", name: null, project: "web", environment: "dev", live_version: 2, status: { build_state: "ready", tier: "standard", last_error: null } },
            { slug: "worker", name: null, project: "web", environment: "dev", live_version: 1, status: { build_state: "ready", tier: "standard", last_error: null } },
          ],
        }),
      ),
    );
    renderWithClient(<CallersSection org={org} app={appFixture()} />);

    expect(await screen.findByLabelText("billing")).toBeInTheDocument();
    expect(screen.getByLabelText("worker")).toBeInTheDocument();
    // An app cannot list itself as a caller.
    expect(screen.queryByLabelText("hello")).toBeNull();
  });

  it("effective limits show source", () => {
    renderWithClient(<LimitsSection org={org} app={appFixture()} />);
    const effective = screen.getByText("Effective").parentElement as HTMLElement;
    expect(within(effective).getByText(/profile/)).toBeInTheDocument();
    expect(within(effective).getByText(/50/)).toBeInTheDocument();
  });

  it("settings save sends If-Match", async () => {
    const user = userEvent.setup();
    const seen: { ifMatch: string | null; body: unknown }[] = [];
    server.use(
      http.patch("/api/orgs/acme/apps/hello", async ({ request }) => {
        seen.push({ ifMatch: request.headers.get("If-Match"), body: await request.json() });
        return HttpResponse.json(appFixture({ etag: '"etag-2"' }), { headers: { ETag: '"etag-2"' } });
      }),
    );
    renderWithClient(<ScalingSection org={org} app={appFixture()} />);

    const max = screen.getByLabelText("Max instances");
    await user.clear(max);
    await user.type(max, "5");
    await user.click(screen.getByRole("button", { name: "Save scaling" }));

    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0].ifMatch).toBe('"etag-1"');
    expect(seen[0].body).toEqual({ scaling: { min_instances: 1, max_instances: 5 } });
  });

  it("status pill shows last_error", () => {
    renderWithClient(
      <StatusPill status={{ build_state: "failed", tier: "standard", last_error: "compile error on line 4", inflight: 0, admission: null }} />,
    );
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("compile error on line 4")).toBeInTheDocument();
  });

  it("egress block saves as a whole and rejects bad JSON", async () => {
    const user = userEvent.setup();
    const patch = vi.fn();
    server.use(
      http.patch("/api/orgs/acme/apps/hello", async () => {
        patch();
        return HttpResponse.json(appFixture());
      }),
    );
    renderWithClient(<EgressSection org={org} app={appFixture()} />);
    const box = screen.getByLabelText("Egress JSON");
    await user.clear(box);
    await user.click(screen.getByRole("button", { name: "Save egress" }));
    expect(await screen.findByText(/valid JSON/i)).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("server 422 field paths land on their inputs", async () => {
    const user = userEvent.setup();
    server.use(
      http.patch("/api/orgs/acme/apps/hello", () =>
        apiError(422, "invalid", "invalid", { details: {
          fields: { "scaling.max_instances": "must be at most 10", "ingress.ip_allow[0]": "overlaps 10.0.0.0/8" } },
        }),
      ),
    );
    renderWithClient(
      <>
        <ScalingSection org={org} app={appFixture()} />
        <IngressSection org={org} app={appFixture()} />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Save scaling" }));
    const maxInput = screen.getByLabelText("Max instances");
    expect(await screen.findByText("must be at most 10")).toBeInTheDocument();
    expect(maxInput).toHaveAttribute("aria-invalid", "true");

    await user.click(screen.getByRole("button", { name: "Save ingress" }));
    expect(await screen.findByText("overlaps 10.0.0.0/8")).toBeInTheDocument();
  });

  it("danger zone delete needs the app slug typed", async () => {
    const user = userEvent.setup();
    const onDeleted = vi.fn();
    const deleted = vi.fn();
    server.use(
      http.delete("/api/orgs/acme/apps/hello", () => {
        deleted();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithClient(<DangerZone org={org} app={appFixture()} onDeleted={onDeleted} />);

    await user.click(screen.getByRole("button", { name: "Delete app" }));
    const confirm = screen.getByRole("button", { name: "Delete permanently" });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/type hello to confirm/i), "hello");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(deleted).toHaveBeenCalled();
  });

  it("danger zone shows why a delete was refused", async () => {
    const user = userEvent.setup();
    const onDeleted = vi.fn();
    const error = vi.spyOn(toast, "error");
    server.use(http.delete("/api/orgs/acme/apps/hello", () => apiError(409, "branch_exists", "Delete this app's branches first.")));
    renderWithClient(<DangerZone org={org} app={appFixture()} onDeleted={onDeleted} />);
    await user.click(screen.getByRole("button", { name: "Delete app" }));
    await user.type(screen.getByLabelText(/type hello to confirm/i), "hello");
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Delete this app's branches first."));
    expect(onDeleted).not.toHaveBeenCalled();
    error.mockRestore();
  });

  describe("data export", () => {
    const URL_ = "/api/orgs/acme/apps/hello/export";
    function stubUrls() {
      const create = vi.fn<(b: Blob) => string>(() => "blob:x");
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
      return create;
    }

    it("saves the file under the app's name", async () => {
      const user = userEvent.setup();
      const create = stubUrls();
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      server.use(http.get(URL_, () => new HttpResponse(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/vnd.sqlite3" } })));
      renderWithClient(<ExportDataButton org={org} app="hello" />);
      await user.click(screen.getByRole("button", { name: "Download" }));
      await waitFor(() => expect(click).toHaveBeenCalled());
      expect(create.mock.calls[0]![0].size).toBe(3);
      expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe("hello.sqlite");
      click.mockRestore();
    });

    it("shows a refused export as a message, not a saved error body", async () => {
      const user = userEvent.setup();
      const create = stubUrls();
      const error = vi.spyOn(toast, "error");
      server.use(http.get(URL_, () => apiError(429, "heavy_job_busy", "Another export is running.")));
      renderWithClient(<ExportDataButton org={org} app="hello" />);
      await user.click(screen.getByRole("button", { name: "Download" }));
      await waitFor(() => expect(error).toHaveBeenCalledWith("Another export is running."));
      expect(create).not.toHaveBeenCalled();
      error.mockRestore();
    });

    it("a download cut midway saves nothing and says to start over", async () => {
      const user = userEvent.setup();
      const create = stubUrls();
      const error = vi.spyOn(toast, "error");
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1]));
          c.error(new Error("cut"));
        },
      });
      const fetched = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
      renderWithClient(<ExportDataButton org={org} app="hello" />);
      await user.click(screen.getByRole("button", { name: "Download" }));
      await waitFor(() => expect(error).toHaveBeenCalledWith("The download was interrupted. Start it again."));
      expect(create).not.toHaveBeenCalled();
      fetched.mockRestore();
      error.mockRestore();
    });
  });
});
