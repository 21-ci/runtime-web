import { act, cleanup } from "@testing-library/react";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vitest";

import { useAppHandlers } from "@/components/features/app-header/fixtures";
import { setCsrfToken } from "@/lib/api";
import { createQueryClient } from "@/lib/query";
import { routeTree } from "@/routeTree.gen";
import { renderAt } from "./render";
import { useShellHandlers } from "./shell-fixtures";

// Sample values substituted for the dynamic segments of every route in the generated tree.
const PARAMS: Record<string, string> = { org: "acme", p: "web", app: "hello", token: "tok-1" };

function allPaths(): string[] {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { queryClient: createQueryClient() },
  });
  const paths = new Set<string>();
  for (const route of Object.values(router.routesById)) {
    const full: string | undefined = route.fullPath;
    if (!full || full === "/") continue;
    paths.add(full.replace(/\$(\w+)/g, (_match: string, name: string) => PARAMS[name] ?? "x"));
  }
  return [...paths].sort();
}

const paths = allPaths();

describe("rendered routes", () => {
  afterEach(() => {
    cleanup();
    setCsrfToken(null);
  });

  it("includes the expected routes", () => {
    expect(paths).toContain("/acme/apps/new");
    expect(paths.length).toBeGreaterThan(5);
  });

  // One test per route so a failure names its path and no route inherits another's timing.
  it.each(paths)("%s renders without the word val", async (path) => {
    useShellHandlers();
    useAppHandlers();
    const router = renderAt(path);
    // Wait for the lazy route chunk and its loaders; query data then renders as it arrives.
    await act(async () => {
      await router.load();
    });
    expect(document.body.textContent ?? "", path).not.toMatch(/\bval\b/i);
  });
});
