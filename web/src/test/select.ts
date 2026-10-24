import { screen, within } from "@testing-library/react";

// pickOption opens a Radix Select trigger and clicks the option with the given accessible name.
// It takes any user-event instance (the default export or a setup() result).
export async function pickOption(
  user: { click: (element: Element) => Promise<unknown> },
  trigger: HTMLElement,
  name: string | RegExp,
) {
  await user.click(trigger);
  const listbox = await screen.findByRole("listbox");
  await user.click(within(listbox).getByRole("option", { name }));
}
