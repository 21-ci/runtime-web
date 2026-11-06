import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { SecretsPanel } from "./secrets-panel";

function renderPanel() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <SecretsPanel org="acme" app="hello" />
    </QueryClientProvider>,
  );
}

describe("SecretsPanel", () => {
  it("secrets show names only, value write-only", async () => {
    const user = userEvent.setup();
    let putBody: unknown = null;
    server.use(
      http.get("/api/orgs/acme/apps/hello/secrets", () =>
        HttpResponse.json({ items: [{ name: "STRIPE_KEY", updated_at: 1_700_000_000_000 }] }),
      ),
      http.put("/api/orgs/acme/apps/hello/secrets/API_TOKEN", async ({ request }) => {
        putBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPanel();

    expect(await screen.findByText("STRIPE_KEY")).toBeInTheDocument();
    expect(screen.queryByLabelText("Value")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Set secret" }));
    const value = await screen.findByLabelText("Value");
    expect(value).toHaveAttribute("type", "password");
    expect(value).toHaveValue("");

    await user.type(screen.getByLabelText("Name"), "API_TOKEN");
    await user.type(value, "s3cret-value");
    await user.click(screen.getByRole("button", { name: "Save secret" }));

    await waitFor(() => expect(putBody).toEqual({ value: "s3cret-value" }));
    // The value is never rendered back, not even right after saving.
    expect(document.body.textContent ?? "").not.toContain("s3cret-value");
    expect(screen.queryByDisplayValue("s3cret-value")).toBeNull();
  });

  it("replaces a secret from its row without asking for the name", async () => {
    const user = userEvent.setup();
    let put = false;
    server.use(
      http.get("/api/orgs/acme/apps/hello/secrets", () => HttpResponse.json({ items: [{ name: "STRIPE_KEY", updated_at: 1_700_000_000_000 }] })),
      http.put("/api/orgs/acme/apps/hello/secrets/STRIPE_KEY", () => ((put = true), new HttpResponse(null, { status: 204 }))),
    );
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Replace STRIPE_KEY" }));
    expect(screen.queryByLabelText("Name")).toBeNull();
    await user.type(await screen.findByLabelText("Value"), "v");
    await user.click(screen.getByRole("button", { name: "Save secret" }));
    await waitFor(() => expect(put).toBe(true));
  });
});
