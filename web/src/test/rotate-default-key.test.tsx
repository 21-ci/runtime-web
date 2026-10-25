import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { server } from "./msw";
import { renderAt } from "./render";
import { orgs, useShellHandlers } from "./shell-fixtures";


describe("rotate default key", { timeout: 15_000 }, () => {
  it("owner rotates after typing the org slug and sees a success toast", async () => {
    useShellHandlers();
    const rotate = vi.fn();
    server.use(
      http.post("/api/orgs/acme/default-key/rotate", () => {
        rotate();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderAt("/acme/settings/general");
    await userEvent.click(await screen.findByRole("button", { name: /rotate default key/i }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: /^rotate key$/i });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/type acme to confirm/i), "acme");
    await userEvent.click(confirm);
    await waitFor(() => expect(rotate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/default key rotated/i)).toBeInTheDocument();
  });

  it("members do not see the control", async () => {
    useShellHandlers();
    server.use(http.get("/api/orgs", () => HttpResponse.json({ items: [{ ...orgs[0], role: "member" }] })));
    renderAt("/acme/settings/general");
    expect(await screen.findByRole("heading", { name: /organization settings/i })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole("button", { name: /rotate default key/i })).toBeNull();
  });
});
