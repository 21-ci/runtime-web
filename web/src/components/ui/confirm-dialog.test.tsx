import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./confirm-dialog";

function setup(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onOpenChange = vi.fn();
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Delete app?"
      description="This removes billing for good."
      confirmLabel="Delete app"
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onOpenChange, onConfirm };
}

describe("ConfirmDialog", () => {
  it("focuses Cancel on open, not the destructive button", () => {
    setup();
    expect(screen.getByRole("alertdialog", { name: "Delete app?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("uses the specific confirm label and calls onConfirm", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.click(screen.getByRole("button", { name: "Delete app" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps the confirm button disabled until the typed value matches", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup({ typedValue: "billing" });
    const confirm = screen.getByRole("button", { name: "Delete app" });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText(/to confirm/i), "billin");
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText(/to confirm/i), "g");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("honours an externally controlled confirmDisabled gate", () => {
    setup({ confirmDisabled: true });
    expect(screen.getByRole("button", { name: "Delete app" })).toBeDisabled();
  });

  it("shows a string error as an alert and offers Retry", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    setup({ error: "Network down", onRetry });
    expect(screen.getByRole("alert")).toHaveTextContent("Network down");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("disables actions and shows the working label while pending", () => {
    setup({ pending: true });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
  });

  it("closes through Cancel", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
