import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { CreateProjectDialog } from "./create-project-dialog";

describe("CreateProjectDialog environments", () => {
  it("starts with dev and prod as chips, and sends the chips as the list", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post("/api/orgs/acme/projects", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ slug: "shop" }, { status: 201 });
      }),
    );
    render(
      <QueryClientProvider client={createQueryClient()}>
        <CreateProjectDialog org="acme" open onOpenChange={() => undefined} />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    expect(screen.getByRole("button", { name: "Remove dev" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove prod" }));
    await user.type(screen.getByLabelText("Environments"), "staging{Enter}");
    await user.type(screen.getByLabelText("Slug"), "shop");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ slug: "shop", environments: ["dev", "staging"] });
  });

  it("refuses an empty environment list in place", async () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <CreateProjectDialog org="acme" open onOpenChange={() => undefined} />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove dev" }));
    await user.click(screen.getByRole("button", { name: "Remove prod" }));
    await user.type(screen.getByLabelText("Slug"), "shop");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByText("Add at least one environment.")).toBeInTheDocument();
  });
});
