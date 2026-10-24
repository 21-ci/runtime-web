import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setCsrfToken } from "@/lib/api";
import { apiError, server } from "@/test/msw";
import { renderAt } from "@/test/render";
import { useShellHandlers } from "@/test/shell-fixtures";

import { useAppHandlers } from "../app-header/fixtures";
import { pickOption } from "@/test/select";

// Routes are code-split, so the first render of each test waits on a lazy chunk.
vi.setConfig({ testTimeout: 20_000 });

const TRIGGERS = "/acme/apps/hello/triggers";

beforeEach(() => {
  setCsrfToken("csrf-token-1");
  useShellHandlers();
});

describe("triggers", () => {
  it("lists pending one-off tasks", async () => {
    useAppHandlers();
    renderAt(TRIGGERS);

    const section = await screen.findByRole("region", { name: "One-off tasks" });
    expect(await within(section).findByText("sch_once_1")).toBeInTheDocument();
  });

  it("dlq redrive requires confirmation", async () => {
    const redrive = vi.fn();
    useAppHandlers({ onRedrive: redrive });
    renderAt(TRIGGERS);

    await userEvent.click(await screen.findByRole("button", { name: "Redrive" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(redrive).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Redrive" }));
    await waitFor(() => expect(redrive).toHaveBeenCalledTimes(1));
  });

  it("dlq purge requires confirmation", async () => {
    const purge = vi.fn();
    useAppHandlers({ onPurge: purge });
    renderAt(TRIGGERS);

    await userEvent.click(await screen.findByRole("button", { name: "Purge DLQ" }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Purge" });
    expect(confirm).toBeDisabled();

    await userEvent.type(within(dialog).getByLabelText("Type purge to confirm"), "purge");
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(purge).toHaveBeenCalledTimes(1));
  });

  it("schedule create explains plan_limit inline", async () => {
    useAppHandlers();
    server.use(
      http.post("/api/orgs/:org/apps/:app/schedules", () =>
        apiError(403, "plan_limit", "trigger not allowed"),
      ),
    );
    renderAt(TRIGGERS);

    await userEvent.click(await screen.findByRole("button", { name: "Add schedule" }));
    await pickOption(userEvent, screen.getByLabelText("Kind"), "Cron");
    await userEvent.type(screen.getByLabelText("Cron expression"), "0 9 * * 1-5");
    await userEvent.click(screen.getByRole("button", { name: "Create schedule" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/not allowed on your plan/i);
  });

  it("cron preview describes the expression", async () => {
    useAppHandlers();
    renderAt(TRIGGERS);

    await userEvent.click(await screen.findByRole("button", { name: "Add schedule" }));
    await pickOption(userEvent, screen.getByLabelText("Kind"), "Cron");
    await userEvent.type(screen.getByLabelText("Cron expression"), "0 9 * * 1-5");

    expect(await screen.findByText("At 09:00, Monday through Friday")).toBeInTheDocument();
  });

  it("enqueue shows busy with a retry action", async () => {
    useAppHandlers();
    let calls = 0;
    server.use(
      http.post("/api/orgs/:org/apps/:app/queue", () => {
        calls += 1;
        return calls === 1 ? apiError(503, "busy", "busy") : new Response(JSON.stringify({ id: "msg_2" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    renderAt(TRIGGERS);

    await userEvent.click(await screen.findByRole("button", { name: "Enqueue test message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/runtime is busy/i);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls).toBe(2));
  });
});
