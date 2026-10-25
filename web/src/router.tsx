import { createRouter } from "@tanstack/react-router";

import { setNavigator, setOnSignedOut } from "@/lib/api";
import { createQueryClient } from "@/lib/query";
import { routeTree } from "@/routeTree.gen";

export const queryClient = createQueryClient();

export const router = createRouter({
  routeTree,
  context: { queryClient },
});

// API redirects (401, password change, MFA enrollment) go through the router, not window.location.
setOnSignedOut(() => queryClient.clear());
setNavigator((to) => {
  void router.navigate({ href: to });
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
