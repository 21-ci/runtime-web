import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { setCsrfToken } from "@/lib/api";
import { useAppHandlers } from "@/components/features/app-header/fixtures";
import { renderAt } from "@/test/render";
import { useShellHandlers } from "@/test/shell-fixtures";

beforeEach(() => {
  setCsrfToken("csrf-token-1");
  useShellHandlers();
});

describe("app settings route", () => {
  it("shows one section at a time from a left sub-nav", async () => {
    useAppHandlers({ effective: { egress_bytes: 1_048_576 } });
    renderAt("/acme/apps/hello/settings");

    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    expect(nav).toHaveTextContent("General");
    expect(screen.queryByRole("heading", { name: "Limits" })).toBeNull();
    expect(screen.queryByText("Effective")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Limits" }));
    expect(await screen.findByText("Effective")).toBeInTheDocument();
    expect(screen.getByText("1 MiB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Limits" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: "Save ingress" })).toBeNull();
  });
});
