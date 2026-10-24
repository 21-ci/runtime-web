import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "@/lib/query";
import { FakeEventSource } from "./fake-event-source";
import { LogsView } from "./logs-view";
import { pickOption } from "@/test/select";

function line(seq: number, msg: string, level = "info") {
  return {
    seq,
    ts: 1_700_000_000_000 + seq,
    level,
    version: 3,
    task_id: null,
    trigger: "http",
    kind: "runtime",
    msg,
    truncated: false,
  };
}

function renderLogs() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <LogsView org="acme" app="hello" />
    </QueryClientProvider>,
  );
}

const latest = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

describe("LogsView", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("logs resume after reconnect", () => {
    renderLogs();
    const es = FakeEventSource.instances[0];
    expect(es.url).toBe("/api/orgs/acme/apps/hello/logs");
    act(() => {
      es.open();
      es.emit("log", line(1, "one"), "1");
      es.emit("log", line(2, "two"), "2");
    });
    expect(screen.getByText("one")).toBeInTheDocument();

    act(() => es.fail(true));
    expect(screen.getByText("Reconnecting")).toBeInTheDocument();

    // The browser resumes with Last-Event-ID and the server replays id 2: it must not duplicate.
    act(() => {
      es.open();
      es.emit("log", line(2, "two"), "2");
      es.emit("log", line(3, "three"), "3");
    });
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getAllByText("two")).toHaveLength(1);
    expect(screen.getByText("three")).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("logs pause buffers new lines", () => {
    renderLogs();
    const es = latest();
    act(() => {
      es.open();
      es.emit("log", line(1, "one"), "1");
    });
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    act(() => es.emit("log", line(2, "held"), "2"));
    expect(screen.queryByText("held")).not.toBeInTheDocument();
    expect(screen.getByText("1 line buffered")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(screen.getByText("held")).toBeInTheDocument();
  });

  it("shows a notice when the server reports a gap", () => {
    renderLogs();
    act(() => latest().emit("gap", { from: 40 }));
    expect(screen.getByText("Some lines were skipped")).toBeInTheDocument();
  });

  it("server error event shows the message and closes the stream", () => {
    renderLogs();
    const es = latest();
    act(() => es.emit("error", { code: "not_found", message: "App was deleted" }));
    expect(screen.getByText("App was deleted")).toBeInTheDocument();
    expect(es.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("clear empties the view", () => {
    renderLogs();
    act(() => {
      latest().open();
      latest().emit("log", line(1, "one"), "1");
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText("one")).not.toBeInTheDocument();
  });

  it("text filter hides non-matching lines", () => {
    renderLogs();
    act(() => {
      latest().open();
      latest().emit("log", line(1, "alpha"), "1");
      latest().emit("log", line(2, "beta"), "2");
    });
    fireEvent.change(screen.getByLabelText("Filter lines"), { target: { value: "alp" } });
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.queryByText("beta")).not.toBeInTheDocument();
  });

  it("level change reopens the stream with the minimum level", async () => {
    renderLogs();
    const first = latest();
    await pickOption(userEvent, screen.getByLabelText("Minimum level"), "Warn and up");
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(latest().url).toBe("/api/orgs/acme/apps/hello/logs?level=warn");
  });
});
