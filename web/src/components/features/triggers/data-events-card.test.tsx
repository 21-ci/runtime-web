import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickOption } from "@/test/select";

import { server } from "@/test/msw";
import { DataEventsCard } from "./data-events-card";

let allowed = true;
vi.mock("@/hooks/authz", () => ({ useCan: () => () => allowed }));
vi.mock("@/components/features/app-header/hooks", () => ({ useAppView: () => ({ data: { project: "web" } }) }));

const URL_ = "/api/orgs/acme/apps/hello/data-events";
const off = { state: "disabled", lag: 0, backlog: 0, last_error: null, tables: [], topic: null, warnings: [] };

function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DataEventsCard org="acme" app="hello" />
    </QueryClientProvider>,
  );
}

describe("DataEventsCard", () => {
  beforeEach(() => {
    allowed = true;
  });

  it("enables events on a table and warns about whole rows", async () => {
    let body: unknown;
    server.use(
      http.get(URL_, () => HttpResponse.json(off)),
      http.put(URL_, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...off, state: "pending", topic: "changes", tables: [] });
      }),
    );
    wrap();
    await userEvent.type(await screen.findByLabelText("Topic"), "changes");
    await userEvent.click(screen.getByRole("button", { name: "Add table" }));
    await userEvent.type(screen.getByLabelText("Table name"), "orders");
    await pickOption(userEvent, screen.getByRole("combobox", { name: "Payload" }), "Whole row");
    expect(screen.getByText(/personal data/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(body).toEqual({ topic: "changes", tables: [{ name: "orders", ops: ["insert", "update"], payload: "row" }], kv_prefixes: [] }),
    );
    expect(await screen.findByText("Starting")).toBeInTheDocument();
  });

  it("needs a topic, offers a rearm when paused, and shows no form without the role", async () => {
    server.use(http.get(URL_, () => HttpResponse.json({ ...off, state: "paused_overflow", backlog: 9 })));
    const first = wrap();
    await userEvent.click(await screen.findByRole("button", { name: "Save and resume" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a topic.");
    first.unmount();

    allowed = false;
    wrap();
    expect(await screen.findByText(/Only project admins/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Topic")).not.toBeInTheDocument();
  });
});
