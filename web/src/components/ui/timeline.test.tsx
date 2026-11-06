import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Rocket } from "lucide-react";
import { describe, expect, it } from "vitest";

import { Timeline, type TimelineItem } from "./timeline";

const NOW = Date.UTC(2026, 10, 6, 12);
const items: TimelineItem[] = [
  { id: "a", icon: Rocket, hue: "blue", title: "Rolled back v3 to v2", actor: "Ann", at: NOW - 3_600_000, rows: [{ label: "Duration", value: "12 s" }] },
  { id: "b", icon: Rocket, title: "Deployed v3", at: NOW - 7_200_000, detail: <p>custom detail</p> },
  { id: "c", icon: Rocket, title: "Env changed", at: NOW - 60_000 },
];

describe("Timeline", () => {
  it("shows title, actor, relative time with the absolute one on hover", () => {
    render(<Timeline items={items} now={NOW} />);
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getByText("Rolled back v3 to v2")).toBeInTheDocument();
    expect(screen.getByText("Ann")).toBeInTheDocument();
    const time = screen.getAllByRole("time")[0];
    expect(time).toHaveAttribute("datetime", new Date(NOW - 3_600_000).toISOString());
    expect(time?.getAttribute("title")).toBeTruthy();
    expect(time?.textContent).toMatch(/ago/);
  });

  it("expands structured detail on demand; an item with none has no toggle", async () => {
    const user = userEvent.setup();
    render(<Timeline items={items} now={NOW} />);
    expect(screen.queryByText("12 s")).toBeNull();
    const toggles = screen.getAllByRole("button");
    expect(toggles).toHaveLength(2);
    await user.click(toggles[0] as HTMLElement);
    expect(toggles[0]).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Duration")).toBeInTheDocument();
    expect(screen.getByText("12 s")).toBeInTheDocument();
    await user.click(toggles[1] as HTMLElement);
    expect(screen.getByText("custom detail")).toBeInTheDocument();
    await user.click(toggles[0] as HTMLElement);
    expect(screen.queryByText("12 s")).toBeNull();
  });
});
