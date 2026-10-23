import { cleanup, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vitest";

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

describe("rendered routes", () => {
  afterEach(() => {
    cleanup();
    setCsrfToken(null);
  });

  it("walks every route in the tree and never renders the word val", async () => {
    useShellHandlers();
    const paths = allPaths();
    expect(paths).toContain("/acme/apps/new");
    expect(paths.length).toBeGreaterThan(5);

    for (const path of paths) {
      cleanup();
      renderAt(path);
      await waitFor(() => expect(document.body.textContent ?? "").not.toMatch(/\bval\b/i), { timeout: 2000 });
      // Let queries settle so late data is covered too.
      await new Promise((r) => setTimeout(r, 50));
      expect(document.body.textContent ?? "", path).not.toMatch(/\bval\b/i);
    }
  });
});
