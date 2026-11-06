import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ChipInput, type ChipInputProps } from "./chip-input";

function Harness({ initial = [], ...rest }: { initial?: string[] } & Partial<ChipInputProps>) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="c">Hosts</label>
      <ChipInput id="c" value={value} onChange={setValue} {...rest} />
      <output data-testid="out">{value.join("|")}</output>
    </>
  );
}
const out = () => screen.getByTestId("out").textContent;

describe("ChipInput", () => {
  it("adds on Enter and comma, dropping blanks and duplicates", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const box = screen.getByLabelText("Hosts");
    await user.type(box, "a.test{Enter}b.test,  ,a.test{Enter}");
    expect(out()).toBe("a.test|b.test");
    expect(box).toHaveValue("");
  });

  it("adds what is typed on blur", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText("Hosts"), "x");
    await user.tab();
    expect(out()).toBe("x");
  });

  it("removes with Backspace on an empty box and with the chip's button", async () => {
    const user = userEvent.setup();
    render(<Harness initial={["a", "b", "c"]} />);
    await user.type(screen.getByLabelText("Hosts"), "{Backspace}");
    expect(out()).toBe("a|b");
    await user.click(screen.getByRole("button", { name: "Remove a" }));
    expect(out()).toBe("b");
  });

  it("splits a paste on whitespace and commas", () => {
    render(<Harness />);
    fireEvent.paste(screen.getByLabelText("Hosts"), { clipboardData: { getData: () => "a, b\nc\td" } });
    expect(out()).toBe("a|b|c|d");
  });

  it("keeps an invalid value in the box with its message and does not add it", async () => {
    const user = userEvent.setup();
    render(<Harness validate={(v) => (v.includes(".") ? null : "Must be a host name")} />);
    const box = screen.getByLabelText("Hosts");
    await user.type(box, "nope{Enter}");
    expect(out()).toBe("");
    expect(box).toHaveValue("nope");
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Must be a host name");
    await user.type(box, ".test{Enter}");
    expect(out()).toBe("nope.test");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("drops only the invalid parts of a paste, naming the first", () => {
    render(<Harness validate={(v) => (v.includes(".") ? null : "Bad")} />);
    fireEvent.paste(screen.getByLabelText("Hosts"), { clipboardData: { getData: () => "a.test bad" } });
    expect(out()).toBe("a.test");
    expect(screen.getByLabelText("Hosts")).toHaveValue("bad");
  });

  it("stops at max and when disabled", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness max={1} initial={["a"]} />);
    expect(screen.getByLabelText("Hosts")).toBeDisabled();
    unmount();
    render(<Harness disabled initial={["a"]} />);
    expect(screen.getByLabelText("Hosts")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Remove a" })).toBeNull();
    await user.keyboard("{Backspace}");
    expect(out()).toBe("a");
  });
});
