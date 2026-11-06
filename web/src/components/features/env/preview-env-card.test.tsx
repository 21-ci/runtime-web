import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { PreviewEnvCard } from "./preview-env-card";

const URL_ = "/api/orgs/acme/apps/hello/preview-env";
const ui = (canWrite: boolean) => (
  <QueryClientProvider client={createQueryClient()}>
    <PreviewEnvCard org="acme" app="hello" canWrite={canWrite} />
  </QueryClientProvider>
);

describe("PreviewEnvCard", () => {
  it("loads and saves the variables", async () => {
    let body: unknown;
    server.use(
      http.get(URL_, () => HttpResponse.json({ env: { FLAG: "on" } })),
      http.put(URL_, async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    render(ui(true));
    expect(await screen.findByDisplayValue("FLAG")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save preview environment" }));
    await waitFor(() => expect(body).toEqual({ env: { FLAG: "on" } }));
  });

  it("says who can change it and does not read the values otherwise", () => {
    let read = false;
    server.use(http.get(URL_, () => ((read = true), HttpResponse.json({ env: {} }))));
    render(ui(false));
    expect(screen.getByRole("note")).toHaveTextContent(/developers and admins/);
    expect(read).toBe(false);
  });
});
