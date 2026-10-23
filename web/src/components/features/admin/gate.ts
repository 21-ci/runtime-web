import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";

import { api } from "@/lib/api";

// meQuery reads GET /api/me under the shared ["me"] key.
export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: () => api.get<{ user: { instance_admin: boolean } }>("/me"),
});

// useIsInstanceAdmin is true only once /api/me says the caller is an instance admin.
export function useIsInstanceAdmin(): boolean {
  return useQuery(meQuery).data?.user.instance_admin === true;
}

// requireInstanceAdmin runs in a route's beforeLoad. It reads GET /api/me fresh (staleTime 0) so a
// role change or a different sign-in is seen on navigation, and sends non-admins to the home page.
// A signed-out caller gets the API client's login redirect instead.
export async function requireInstanceAdmin(queryClient: QueryClient) {
  const me = await queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
  if (!me.user.instance_admin) {
    throw redirect({ to: "/" });
  }
}
