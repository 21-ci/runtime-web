import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ExportMenu } from "./export-menu";

describe("ExportMenu", () => {
  it("offers one link per server format, with the on-screen filters in the URL", async () => {
    const user = userEvent.setup();
    render(<ExportMenu label="Export logs" formats={["ndjson", "txt"]} href={(f) => `/api/orgs/a/apps/b/logs?level=warn&format=${f}`} />);
    await user.click(screen.getByRole("button", { name: "Export logs" }));
    const ndjson = screen.getByRole("menuitem", { name: ".ndjson" });
    expect(ndjson).toHaveAttribute("href", "/api/orgs/a/apps/b/logs?level=warn&format=ndjson");
    expect(ndjson).toHaveAttribute("download");
    expect(screen.getByRole("menuitem", { name: ".txt" })).toHaveAttribute("href", "/api/orgs/a/apps/b/logs?level=warn&format=txt");
  });

  it("goes straight to the file when there is one format", () => {
    render(<ExportMenu label="Export versions" formats={["csv"]} href={(f) => `/x?format=${f}`} />);
    const link = screen.getByRole("link", { name: "Export versions" });
    expect(link).toHaveAttribute("href", "/x?format=csv");
    expect(link).toHaveAttribute("download");
  });

  it("is disabled in server mode when asked", () => {
    render(<ExportMenu formats={["csv"]} href={() => "/x"} disabled />);
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("still downloads rows on screen in client mode, and is disabled with none", async () => {
    const user = userEvent.setup();
    const created = vi.fn<(b: Blob) => string>(() => "blob:x");
    URL.createObjectURL = created as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { rerender } = render(<ExportMenu name="points" rows={[]} />);
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
    rerender(<ExportMenu name="points" rows={[{ a: 1 }]} />);
    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("menuitem", { name: "CSV" }));
    expect(created).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
  });
});
