import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { AlertsPage } from "./alerts-page";
import { ORG_KINDS, orgAlerts } from "./use-alerts";

afterEach(cleanup);

const CHANNEL = { id: "ach_1", kind: "webhook", name: "ops", created_at: 1, last_ok_at: null, last_error: "4xx" };
const RULE = { id: "arl_1", kind: "build_failed", app: null, params: {}, channels: ["ach_1"], enabled: true, for_s: 300, repeat_s: 14400, muted_until: null, created_at: 1 };

function mount(channels: unknown[] = [CHANNEL], rules: unknown[] = [RULE], active: unknown[] = []) {
  const posts: unknown[] = [];
  server.use(
    http.get("*/api/orgs/acme/alerts/channels", () => HttpResponse.json({ items: channels })),
    http.get("*/api/orgs/acme/alerts/rules", () => HttpResponse.json({ items: rules })),
    http.get("*/api/orgs/acme/alerts/active", () => HttpResponse.json({ items: active })),
    http.post("*/api/orgs/acme/alerts/channels", async ({ request }) => {
      posts.push(await request.json());
      return HttpResponse.json(CHANNEL, { status: 201 });
    }),
    http.post("*/api/orgs/acme/alerts/rules", async ({ request }) => {
      posts.push(await request.json());
      return HttpResponse.json(RULE, { status: 201 });
    }),
  );
  const qc = createQueryClient();
  qc.setDefaultOptions({ queries: { retry: false } });
  render(
    <QueryClientProvider client={qc}>
      <AlertsPage base={orgAlerts("acme")} kinds={ORG_KINDS} allowApp />
    </QueryClientProvider>,
  );
  return posts;
}

describe("AlertsPage", () => {
  it("shows a channel's name and status class, active alerts and rules", async () => {
    mount([CHANNEL], [RULE], [{ rule_id: "arl_1", kind: "app_error_rate", subject: "hello", state: "firing", since: 1, value: 20 }]);
    expect((await screen.findAllByText("ops")).length).toBeGreaterThan(0);
    expect(await screen.findByText(/4xx/)).toBeTruthy();
    expect(await screen.findByText("hello")).toBeTruthy();
    expect((await screen.findAllByText("Build failed")).length).toBeGreaterThan(0);
  });

  it("creates a webhook channel with the fields the API takes", async () => {
    const posts = mount([], []);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "pager");
    await user.type(screen.getByLabelText("URL"), "https://hooks.example.com/x");
    await user.type(screen.getByLabelText("Signing secret"), "0123456789abcdef");
    await user.click(screen.getByRole("button", { name: "Add channel" }));
    await waitFor(() => expect(posts).toEqual([{ kind: "webhook", name: "pager", config: { url: "https://hooks.example.com/x", secret: "0123456789abcdef" } }]));
  });

  it("does not delete a rule or channel until confirmed", async () => {
    const deletes: string[] = [];
    server.use(http.delete(/\/alerts\/(channels|rules)\//, ({ request }) => {
      deletes.push(new URL(request.url).pathname.split("/alerts/")[1] ?? "");
      return new HttpResponse(null, { status: 204 });
    }));
    mount([CHANNEL], [RULE]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete rule" }));
    expect(deletes).toEqual([]);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deletes).toEqual(["rules/arl_1"]));
  });

  it("mutes and edits a rule's threshold", async () => {
    const patches: unknown[] = [];
    server.use(http.patch(/\/alerts\/rules\//, async ({ request }) => {
      patches.push(await request.json());
      return HttpResponse.json(RULE);
    }));
    mount([CHANNEL], [{ ...RULE, kind: "app_error_rate", params: { threshold_pct: 5, min_requests: 100 } }]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Mute for 24 hours" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect((patches[0] as { muted_until: number }).muted_until).toBeGreaterThan(Date.now());
    await user.click(screen.getAllByRole("button", { name: "Edit" }).at(-1) as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    const box = within(dialog).getByLabelText("Error rate above (%)");
    await user.clear(box);
    await user.type(box, "9");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches[1]).toMatchObject({ params: { threshold_pct: 9, min_requests: 100 }, channels: ["ach_1"] }));
  });

  it("renames a channel without resending its write-only config", async () => {
    const patches: unknown[] = [];
    server.use(http.patch(/\/alerts\/channels\//, async ({ request }) => {
      patches.push(await request.json());
      return HttpResponse.json(CHANNEL);
    }));
    mount([CHANNEL], []);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit channel ops" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "pager");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches).toEqual([{ name: "pager" }]));
  });

  it("asks for a channel before a rule", async () => {
    mount([], []);
    expect(await screen.findByText(/Add a channel first/)).toBeTruthy();
  });

  it("creates a rule on the first channel", async () => {
    const posts = mount([CHANNEL], []);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(posts).toEqual([{ kind: "app_error_rate", channels: ["ach_1"] }]));
  });
});
