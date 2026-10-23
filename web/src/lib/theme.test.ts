import { afterEach, describe, expect, it, vi } from "vitest";

import { applyTheme, readTheme, writeTheme } from "./theme";

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
});
