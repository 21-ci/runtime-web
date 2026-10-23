import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";

import { api } from "@/lib/api";

// requireInstanceAdmin runs in a route's beforeLoad. It reads GET /api/me fresh (staleTime 0) so a
// role change or a different sign-in is seen on navigation, and sends non-admins to the home page.
// A signed-out caller gets the API client's login redirect instead.
export async function requireInstanceAdmin(queryClient: QueryClient) {
  const me = await queryClient.fetchQuery({
    queryKey: ["me"],
    queryFn: () => api.get<{ user: { instance_admin: boolean } }>("/me"),
    staleTime: 0,
  });
  if (!me.user.instance_admin) {
    throw redirect({ to: "/" });
  }
}
