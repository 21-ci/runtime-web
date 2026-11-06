import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LineChart } from "./line-chart";

const labels = { noData: "No data", table: "Table", time: "Time", value: "Value" };

describe("LineChart", () => {
  afterEach(() => cleanup());

  it("marks a lone value with a dot, since it draws no line", () => {
    render(<LineChart title="Requests" labels={labels} points={[{ ts: 1, value: 10 }]} />);
    expect(screen.getByTestId("chart-dot")).toBeInTheDocument();
  });

  it("draws no dots on a connected line", () => {
    render(<LineChart title="Requests" labels={labels} points={[{ ts: 1, value: 10 }, { ts: 2, value: 5 }]} />);
    expect(screen.queryByTestId("chart-dot")).toBeNull();
  });

  it("draws a measured all-zero series as zero, not as no data", () => {
    render(<LineChart title="Errors" labels={labels} points={[{ ts: 1, value: 0 }, { ts: 2, value: 0 }]} />);
    expect(screen.queryByText("No data")).toBeNull();
    expect(screen.getByTestId("chart-line").getAttribute("d")).toMatch(/^M.+L/);
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
  });

  it("keeps No data for absent points only", () => {
    const { rerender } = render(<LineChart title="Errors" labels={labels} points={[]} />);
    expect(screen.getByText("No data")).toBeInTheDocument();
    rerender(<LineChart title="Errors" labels={labels} points={[{ ts: 1, value: null }, { ts: 2, value: null }]} />);
    expect(screen.getByText("No data")).toBeInTheDocument();
    rerender(<LineChart title="Errors" labels={labels} points={[{ ts: 1, value: null }, { ts: 2, value: 0 }]} />);
    expect(screen.queryByText("No data")).toBeNull();
    expect(screen.getByTestId("chart-dot")).toBeInTheDocument();
  });
});
