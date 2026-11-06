import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/test/msw";
import { createQueryClient } from "@/lib/query";
import { FakeEventSource } from "./fake-event-source";
import { LogsView } from "./logs-view";
import { MAX_AUTO_RETRIES, retryDelay } from "./use-log-stream";
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

  it("says what the page shows: what the code prints, not each request", () => {
    renderLogs();
    expect(screen.getByText(/what your code prints/i)).toBeInTheDocument();
    expect(screen.getByText(/requests are not listed/i)).toBeInTheDocument();
    expect(screen.getByText(/prints something/i)).toBeInTheDocument();
  });

  it("shows structured log fields", () => {
    renderLogs();
    act(() => {
      latest().open();
      latest().emit("log", { ...line(1, "order placed"), fields: { order: 7 } }, "1");
    });
    fireEvent.click(screen.getByRole("button", { name: /order placed/ }));
    expect(screen.getByText("order")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("http")).toBeInTheDocument();
  });

  it("@level and @kind tokens filter what the stream shows", () => {
    renderLogs();
    act(() => {
      latest().open();
      latest().emit("log", line(1, "calm"), "1");
      latest().emit("log", line(2, "boom", "error"), "2");
    });
    fireEvent.change(screen.getByLabelText("Filter lines"), { target: { value: "@level:error" } });
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.queryByText("calm")).not.toBeInTheDocument();
  });

  it("the kind select filters the stream", async () => {
    renderLogs();
    act(() => {
      latest().open();
      latest().emit("log", line(1, "app line"), "1");
      latest().emit("log", { ...line(2, "compile line"), kind: "build" }, "2");
    });
    await pickOption(userEvent, screen.getByLabelText("Kind"), "Build");
    expect(screen.getByText("compile line")).toBeInTheDocument();
    expect(screen.queryByText("app line")).not.toBeInTheDocument();
  });

  describe("range mode", () => {
    function ndjson(rows: unknown[], seen?: URL[]) {
      server.use(
        http.get("/api/orgs/acme/apps/hello/logs", ({ request }) => {
          seen?.push(new URL(request.url));
          return new HttpResponse(rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), { headers: { "content-type": "application/x-ndjson" } });
        }),
      );
    }

    it("closes the stream and reads the window from the server", async () => {
      const seen: URL[] = [];
      ndjson([line(1, "old line")], seen);
      renderLogs();
      const es = latest();
      fireEvent.click(screen.getByRole("radio", { name: "Range" }));
      expect(es.closed).toBe(true);
      expect(await screen.findByText("old line")).toBeInTheDocument();
      expect(seen[0]?.searchParams.get("view")).toBe("range");
      expect(seen[0]?.searchParams.get("format")).toBeNull();
      expect(seen[0]?.searchParams.get("since")).toMatch(/Z$/);
      expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    });

    it("an empty window names the range", async () => {
      ndjson([]);
      renderLogs();
      fireEvent.click(screen.getByRole("radio", { name: "Range" }));
      expect(await screen.findByText(/^No log lines between .+ and .+\.$/)).toBeInTheDocument();
    });

    it("export carries the range and level", async () => {
      ndjson([line(1, "old line")]);
      const user = userEvent.setup();
      renderLogs();
      await user.click(screen.getByRole("radio", { name: "Range" }));
      await user.click(screen.getByRole("button", { name: "Export" }));
      const href = (await screen.findByRole("menuitem", { name: ".txt" })).getAttribute("href") ?? "";
      expect(href).toContain("/api/orgs/acme/apps/hello/logs?format=txt");
      expect(href).toContain("since=");
    });
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

  it("auto-retries a closed stream with backoff, then offers Reconnect", () => {
    vi.useFakeTimers();
    try {
      renderLogs();
      act(() => {
        latest().open();
        latest().emit("log", line(1, "one"), "1");
      });
      for (let i = 0; i < MAX_AUTO_RETRIES; i++) {
        act(() => latest().fail(false));
        expect(screen.getByText("Reconnecting")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
        act(() => vi.advanceTimersByTime(retryDelay(i) - 1));
        expect(FakeEventSource.instances).toHaveLength(i + 1);
        act(() => vi.advanceTimersByTime(1));
        expect(FakeEventSource.instances).toHaveLength(i + 2);
        expect(FakeEventSource.instances[i]?.closed).toBe(true);
      }
      act(() => latest().fail(false));
      expect(screen.getByText("Disconnected")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(60_000));
      expect(FakeEventSource.instances).toHaveLength(MAX_AUTO_RETRIES + 1);
      expect(screen.getByText("one")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
      expect(FakeEventSource.instances).toHaveLength(MAX_AUTO_RETRIES + 2);
      act(() => {
        latest().open();
        latest().emit("log", line(1, "one"), "1");
      });
      expect(screen.getByText("Connected")).toBeInTheDocument();
      expect(screen.getAllByText("one")).toHaveLength(1);
      expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Reconnect after a server error event clears the message and reopens", () => {
    renderLogs();
    act(() => latest().emit("error", { code: "not_found", message: "App was deleted" }));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(screen.queryByText("App was deleted")).not.toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});
