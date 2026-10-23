import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";

import { setNavigator } from "@/lib/api";
import { createQueryClient } from "@/lib/query";
import { routeTree } from "@/routeTree.gen";

// renderAt mounts the real file-route tree at `path` with an in-memory history.
// Redirects from the API client navigate this router, so tests can assert router.state.location.
export function renderAt(path: string) {
  const queryClient = createQueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient },
  });
  setNavigator((to) => {
    void router.navigate({ href: to });
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}
