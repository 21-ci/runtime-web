import { createContext, useContext } from "react";

import type { Theme } from "@/lib/theme";

// ShellState is the app shell's shared UI state: the command palette, the theme choice and the
// collapsed sidebar. AppShell owns it; the topbar, sidebar, palette and theme toggle read it.
export type ShellState = {
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
};

export const ShellContext = createContext<ShellState | null>(null);

// useShell returns the shell state. It throws outside AppShell, which is a programming error.
export function useShell(): ShellState {
  const s = useContext(ShellContext);
  if (!s) throw new Error("useShell must be used inside AppShell");
  return s;
}
