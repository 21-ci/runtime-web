// Theme choice: "system" follows the OS, "light" and "dark" override it. The choice lives in
// localStorage (per-viewer convenience). Every storage access is wrapped: private windows and
// blocked storage fall back to "system" without throwing.
export type Theme = "system" | "light" | "dark";

export const THEME_KEY = "rt-theme";

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function writeTheme(theme: Theme) {
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage blocked: the choice still applies for this page view.
  }
}

// applyTheme toggles the .dark class on <html>. "system" consults the OS preference.
export function applyTheme(theme: Theme) {
  let dark = theme === "dark";
  if (theme === "system") {
    try {
      dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch {
      dark = false;
    }
  }
  document.documentElement.classList.toggle("dark", dark);
}
