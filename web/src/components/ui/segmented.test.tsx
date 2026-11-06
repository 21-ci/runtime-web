import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Segmented } from "./segmented";

const options = [
  { value: "1h", label: "1 h" },
  { value: "24h", label: "24 h" },
  { value: "7d", label: "7 d" },
];

describe("Segmented", () => {
  it("is a labelled radio group showing the current value", () => {
    render(<Segmented label="Period" value="24h" onChange={() => {}} options={options} />);
    expect(screen.getByRole("radiogroup", { name: "Period" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "24 h" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "24 h" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "1 h" })).toHaveAttribute("tabindex", "-1");
  });

  it("selects on click; a click on the current one is silent", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Segmented label="Period" value="24h" onChange={onChange} options={options} />);
    await user.click(screen.getByRole("radio", { name: "24 h" }));
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("radio", { name: "7 d" }));
    expect(onChange).toHaveBeenCalledWith("7d");
  });

  it("moves with the arrow keys and wraps", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Segmented label="Period" value="7d" onChange={onChange} options={options} />);
    screen.getByRole("radio", { name: "7 d" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("1h");
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("24h");
    expect(screen.getByRole("radio", { name: "24 h" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("1h");
  });
});
