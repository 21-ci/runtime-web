import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { BoundedItems, wholeRowsHeight } from "./bounded";

describe("wholeRowsHeight", () => {
  function table(bottoms: number[]) {
    const el = document.createElement("div");
    el.innerHTML = `<table><tbody>${bottoms.map(() => "<tr></tr>").join("")}</tbody></table>`;
    el.querySelectorAll("tr").forEach((tr, i) => {
      tr.getBoundingClientRect = () => ({ bottom: 100 + (bottoms[i] ?? 0) }) as DOMRect;
    });
    el.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    return el;
  }

  it("ends on the last row that fits when rows run past the cap", () => {
    expect(wholeRowsHeight(table([180, 360, 400]))).toBe(360);
  });

  it("leaves the height alone when every row fits", () => {
    expect(wholeRowsHeight(table([100, 200]))).toBeNull();
  });
});

const items = Array.from({ length: 14 }, (_, i) => `item ${i}`);
const base = { items, getKey: (s: string) => s, renderItem: (s: string) => <span>{s}</span> };

describe("BoundedItems", () => {
  beforeEach(() => localStorage.clear());

  it("shows the limit, opens the rest in an inner scroll, and closes again", async () => {
    const user = userEvent.setup();
    render(<BoundedItems {...base} maxItems={5} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    const toggle = screen.getByRole("button", { name: "Show all (14)" });
    await user.click(toggle);
    expect(screen.getAllByRole("listitem")).toHaveLength(14);
    expect(screen.getByRole("list").className).toMatch(/max-h-\[480px\]/);
    expect(screen.getByRole("list").className).toMatch(/overflow-y-auto/);
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });

  it("offers no toggle when everything fits, and defaults to ten", () => {
    const { rerender } = render(<BoundedItems {...base} items={items.slice(0, 3)} />);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<BoundedItems {...base} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
  });

  it("links out instead of expanding when given a View all link", () => {
    render(<BoundedItems {...base} maxItems={5} viewAll={<a href="/audit">View all</a>} />);
    expect(screen.getByRole("link", { name: "View all" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("collapses from its header and remembers it per user", async () => {
    const user = userEvent.setup();
    const props = { ...base, title: "Sessions", collapseId: "security.sessions" };
    const { unmount } = render(<BoundedItems {...props} />);
    await user.click(screen.getByRole("button", { name: "Sessions" }));
    expect(screen.queryByRole("list")).toBeNull();
    expect(localStorage.getItem("ui.collapse.security.sessions")).toBe("1");
    unmount();
    render(<BoundedItems {...props} />);
    expect(screen.queryByRole("list")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Sessions" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    expect(localStorage.getItem("ui.collapse.security.sessions")).toBe("0");
  });

  it("shows the empty node with no items", () => {
    render(<BoundedItems {...base} items={[]} empty={<p>None yet</p>} />);
    expect(screen.getByText("None yet")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });
});
