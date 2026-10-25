import { afterEach, describe, expect, it, vi } from "vitest";

import { applyTheme, readTheme, subscribeSystemTheme, writeTheme } from "./theme";

afterEach(() => {
  document.documentElement.classList.remove("dark");
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("theme", () => {
  it("persists the choice and applies the dark class", () => {
    writeTheme("dark");
    expect(localStorage.getItem("rt-theme")).toBe("dark");
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(readTheme()).toBe("dark");
  });

  it("falls back to system when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readTheme()).toBe("system");
    expect(() => writeTheme("light")).not.toThrow();
  });

  it("system theme follows OS scheme changes while subscribed", () => {
    let dark = false;
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    const original = window.matchMedia;
    window.matchMedia = (query: string) =>
      ({
        get matches() {
          return dark;
        },
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: (_t: string, l: (e: MediaQueryListEvent) => void) => listeners.add(l),
        removeEventListener: (_t: string, l: (e: MediaQueryListEvent) => void) => listeners.delete(l),
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
    try {
      applyTheme("system");
      const unsubscribe = subscribeSystemTheme(() => applyTheme("system"));
      expect(document.documentElement.classList.contains("dark")).toBe(false);

      dark = true;
      listeners.forEach((l) => l({ matches: true } as MediaQueryListEvent));
      expect(document.documentElement.classList.contains("dark")).toBe(true);

      unsubscribe();
      expect(listeners.size).toBe(0);
    } finally {
      window.matchMedia = original;
    }
  });
});
