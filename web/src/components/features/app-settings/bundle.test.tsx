import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { BundleSection } from "./bundle";

function setup() {
  const client = createQueryClient();
  const router = createRouter({
    history: createMemoryHistory(),
    routeTree: createRootRoute({
      component: () => (
        <QueryClientProvider client={client}>
          <BundleSection org="acme" app="hello" project="web" environment="dev" />
        </QueryClientProvider>
      ),
    }),
  });
  render(<RouterProvider router={router} />);
}

const IMPORT = "/api/orgs/acme/apps/import";
const created = () => HttpResponse.json({ slug: "copy", warnings: [], missing_secrets: ["API_KEY"] }, { status: 202 });

afterEach(cleanup);

describe("BundleSection", () => {
  it("keeps export, fork and import apart", async () => {
    setup();
    expect(await screen.findByRole("heading", { name: "Export a bundle" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Fork this App" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Import a bundle" })).toBeInTheDocument();
  });

  it("links to the fork it made and names the secrets to enter again", async () => {
    let url = "";
    server.use(http.post(IMPORT, ({ request }) => ((url = request.url), created())));
    setup();
    await userEvent.type(await screen.findByLabelText("Name of the fork"), "copy");
    await userEvent.click(screen.getByRole("button", { name: "Fork" }));
    expect(await screen.findByRole("link", { name: "Open copy" })).toHaveAttribute("href", "/acme/apps/copy");
    expect(screen.getByText(/API_KEY/)).toBeInTheDocument();
    expect(new URL(url).searchParams.get("from")).toBe("hello");
  });

  it("says a name is taken in words", async () => {
    server.use(http.post(IMPORT, () => HttpResponse.json({ error: { code: "slug_taken", message: "slug taken" } }, { status: 409 })));
    setup();
    await userEvent.type(await screen.findByLabelText("Name of the fork"), "copy");
    await userEvent.click(screen.getByRole("button", { name: "Fork" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already has that name/i);
  });

  it("checks the name as you type and does not submit a bad one", async () => {
    setup();
    await userEvent.type(await screen.findByLabelText("Name of the fork"), "Bad_");
    expect(screen.getByText(/can't use B, _/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fork" })).toBeDisabled();
  });

  it("import needs a file, shows its size and refuses one over the limit", async () => {
    setup();
    await userEvent.type(await screen.findByLabelText("Name of the new App"), "copy");
    const importButton = screen.getByRole("button", { name: "Import bundle" });
    expect(importButton).toBeDisabled();
    const input = screen.getByLabelText("Bundle file");
    await userEvent.upload(input, new File(["abc"], "a.tar.zst"));
    expect(screen.getByText(/3 B of 4 MiB/)).toBeInTheDocument();
    await waitFor(() => expect(importButton).toBeEnabled());
    await userEvent.upload(input, new File([new Uint8Array((4 << 20) + 1)], "big.tar.zst"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/over 4 MiB/);
    expect(importButton).toBeDisabled();
  });

  it("shows why an upload was refused", async () => {
    server.use(http.post(IMPORT, () => HttpResponse.json({ error: { code: "slug_taken", message: "slug taken" } }, { status: 409 })));
    setup();
    await userEvent.type(await screen.findByLabelText("Name of the new App"), "copy");
    await userEvent.upload(screen.getByLabelText("Bundle file"), new File(["abc"], "a.tar.zst"));
    await userEvent.click(screen.getByRole("button", { name: "Import bundle" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already has that name/i);
  });
});
