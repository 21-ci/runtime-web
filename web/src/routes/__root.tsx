import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

import { Toaster } from "@/components/ui/toast";
import { RuntimeStatusBanner } from "@/components/runtime-status-banner";

type RouterContext = { queryClient: QueryClient };

function RootLayout() {
  return (
    <>
      <RuntimeStatusBanner />
      <Outlet />
      <Toaster />
    </>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});
