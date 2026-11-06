import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DataTable, type DataColumn } from "./data-table";

interface R {
  id: string;
  name: string;
  n: number;
}
const rows: R[] = [
  { id: "1", name: "beta", n: 2 },
  { id: "2", name: "alpha", n: 10 },
  { id: "3", name: "gamma", n: 1 },
];
const columns: DataColumn<R>[] = [
  { key: "name", header: "Name", cell: (r) => r.name, primary: true, sortValue: (r) => r.name },
  { key: "n", header: "Requests", cell: (r) => r.n, align: "right", sortValue: (r) => r.n, title: (r) => `${r.n} requests` },
];
const names = () => screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0]?.textContent);

describe("DataTable", () => {
  it("renders header, count and right-aligned numbers with a title tooltip", () => {
    render(<DataTable label="Apps" columns={columns} rows={rows} rowKey={(r) => r.id} count="3 apps" />);
    expect(screen.getByRole("table", { name: "Apps" })).toBeInTheDocument();
    expect(screen.getByText("3 apps")).toBeInTheDocument();
    const cell = screen.getByTitle("10 requests");
    expect(cell.className).toMatch(/text-right/);
    expect(cell.className).toMatch(/tabular-nums/);
  });

  it("sorts on header click and exposes aria-sort", async () => {
    const user = userEvent.setup();
    render(<DataTable label="Apps" columns={columns} rows={rows} rowKey={(r) => r.id} />);
    await user.click(screen.getByRole("button", { name: "Requests" }));
    expect(screen.getByRole("columnheader", { name: "Requests" })).toHaveAttribute("aria-sort", "ascending");
    expect(names()).toEqual(["gamma", "beta", "alpha"]);
    await user.click(screen.getByRole("button", { name: "Requests" }));
    expect(screen.getByRole("columnheader", { name: "Requests" })).toHaveAttribute("aria-sort", "descending");
    expect(names()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("does not resort when sorting is controlled by the server", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    render(<DataTable label="Apps" columns={columns} rows={rows} rowKey={(r) => r.id} sort={{ key: "name", dir: "asc" }} onSortChange={onSortChange} />);
    expect(names()).toEqual(["beta", "alpha", "gamma"]);
    await user.click(screen.getByRole("button", { name: "Name" }));
    expect(onSortChange).toHaveBeenCalledWith({ key: "name", dir: "desc" });
  });

  it("limits to the page size and pages on with Load more", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 25 }, (_, i) => ({ id: String(i), name: `n${i}`, n: i }));
    render(<DataTable label="Apps" columns={columns} rows={many} rowKey={(r) => r.id} />);
    expect(screen.getAllByRole("row")).toHaveLength(21);
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(screen.getAllByRole("row")).toHaveLength(26);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("asks the server for more when it has a cursor, with a pending state", async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    const { rerender } = render(<DataTable label="Apps" columns={columns} rows={rows} rowKey={(r) => r.id} hasMore onLoadMore={onLoadMore} />);
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledOnce();
    rerender(<DataTable label="Apps" columns={columns} rows={rows} rowKey={(r) => r.id} hasMore onLoadMore={onLoadMore} loadingMore />);
    expect(screen.getByRole("button", { name: "Load more" })).toBeDisabled();
  });

  it("shows skeleton rows while loading and the empty node with no rows", () => {
    const { rerender, container } = render(<DataTable label="Apps" columns={columns} rows={[]} rowKey={(r: R) => r.id} loading />);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(5);
    expect(container.querySelector("tbody tr")).toHaveAttribute("aria-hidden", "true");
    rerender(<DataTable label="Apps" columns={columns} rows={[]} rowKey={(r: R) => r.id} empty={<p>No apps yet</p>} />);
    expect(screen.getByText("No apps yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("stacks into labelled cards under md only past three columns", () => {
    const wide: DataColumn<R>[] = ["a", "b", "c", "d"].map((k) => ({ key: k, header: k.toUpperCase(), cell: (r) => r.name }));
    const { container, rerender } = render(<DataTable label="Apps" columns={wide} rows={rows} rowKey={(r) => r.id} />);
    expect(container.querySelector("table")?.className).toMatch(/table-stack/);
    expect(container.querySelector("td")).toHaveAttribute("data-label", "A");
    expect(container.querySelector("td:last-child")).toHaveAttribute("data-label", "D");
    rerender(<DataTable label="Apps" columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(container.querySelector("table")?.className).not.toMatch(/table-stack/);
  });
});
