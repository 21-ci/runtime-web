import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { eventFields } from "@/components/features/overview/events-panel";

import { KeyValueCard } from "./key-value-card";

const query = (data: Record<string, unknown>) => ({ data, isPending: false, isError: false, error: null, refetch: () => {} });

describe("KeyValueCard", () => {
  it("renders runtime objects as readable rows with units", () => {
    render(
      <KeyValueCard
        title="Status"
        query={query({
          version: "0.1.1",
          v8_sandbox: false,
          memory: { budget_bytes: 1_073_741_824, pressure: "Normal" },
          uptime_ms: 120_000,
          tags: ["a", "b"],
          nothing: null,
        })}
      />,
    );
    const card = screen.getByRole("region", { name: "Status" });
    expect(within(card).getByText("V8 sandbox")).toBeInTheDocument();
    expect(within(card).getByText("no")).toBeInTheDocument();
    expect(within(card).getByText("Budget bytes")).toBeInTheDocument();
    expect(within(card).getByText("1.00 GiB")).toBeInTheDocument();
    expect(within(card).getByText("2 min")).toBeInTheDocument();
    expect(within(card).getByText("a")).toBeInTheDocument();
    expect(within(card).getByText("-")).toBeInTheDocument();
  });

  it("renders a list of same-shaped objects as a table", () => {
    render(
      <KeyValueCard
        title="Scheduler"
        query={query({ procs: [{ id: 0, kind: "deno", status: "idle" }, { id: 1, kind: "wasm", status: "running" }] })}
      />,
    );
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Kind" })).toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("running")).toBeInTheDocument();
  });

  it("shows the loading and error states", () => {
    const { rerender } = render(<KeyValueCard title="Status" query={{ isPending: true, isError: false, error: null, refetch: () => {} }} />);
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    rerender(<KeyValueCard title="Status" query={{ isPending: false, isError: true, error: new Error("x"), refetch: () => {} }} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("eventFields", () => {
  it("flattens nested payloads into labelled values", () => {
    expect(eventFields({ version: 3, actor: { kind: "key", key_id: "k1" }, took_ms: 1500, list: [1] })).toEqual([
      { label: "Version", value: "3" },
      { label: "Actor kind", value: "key" },
      { label: "Actor key id", value: "k1" },
      { label: "Took ms", value: "1.5 s" },
      { label: "List", value: "[1]" },
    ]);
    expect(eventFields(null)).toEqual([]);
    expect(eventFields("plain")).toEqual([{ label: "Value", value: "plain" }]);
    expect(eventFields([])).toEqual([{ label: "Items", value: "none" }]);
  });
});
