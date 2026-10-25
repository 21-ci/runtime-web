import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";

import { resetApiForTests } from "@/lib/api";
// English resources are bundled, so i18n is ready synchronously and tests match English text.
import { i18n, LANGUAGE_STORAGE_KEY } from "@/lib/i18n";

import { server } from "./msw";

// Safety net only: tests await the specific state they need, and this bounds the wait when the
// machine is loaded (lazy route chunks, parallel workers, coverage instrumentation).
configure({ asyncUtilTimeout: 10_000 });

// jsdom gaps: sonner reads matchMedia for theme="system", and router scroll restoration calls scrollTo.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
window.scrollTo = () => {};
// cmdk scrolls the active item into view, which jsdom does not implement.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
// cmdk measures its list with ResizeObserver, which jsdom does not provide.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// Radix Select pointer handling needs pointer capture, which jsdom does not implement.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
}

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

// Module-level state in lib/api must not leak between tests: each test starts signed out, with the
// default browser navigator, and no sign-out hook. renderAt installs its own per test.
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetApiForTests();
  try {
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  } catch {
    // Storage unavailable in this environment: nothing to reset.
  }
  if (i18n.language !== "en") void i18n.changeLanguage("en");
});

afterAll(() => {
  server.close();
});
