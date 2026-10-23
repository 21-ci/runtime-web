import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useOrgs } from "@/hooks/orgs";
import { api } from "@/lib/api";
import type { OrgRole, User } from "@/lib/types";

// Shape from docs/api-web.md §7. grants maps project slug to project role.
export type Member = {
  user: Pick<User, "id" | "email" | "name">;
  role: OrgRole;
  grants: Record<string, string>;
};

export function useMembers(org: string) {
  return useQuery({
    queryKey: ["members", org],
    queryFn: () => api.get<{ items: Member[] }>(`/orgs/${encodeURIComponent(org)}/members`).then((r) => r.items),
  });
}

export function useSetMemberRole(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ user, role }: { user: string; role: OrgRole }) =>
      api.patch<Member>(`/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(user)}`, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members", org] }),
  });
}

export function useRemoveMember(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (user: string) => api.del<void>(`/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(user)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members", org] }),
  });
}

// useOrgRole returns the caller's role in the org, or null when not a member (or still loading).
export function useOrgRole(org: string): { role: OrgRole | null; isPending: boolean } {
  const orgs = useOrgs();
  if (orgs.isPending) return { role: null, isPending: true };
  return { role: orgs.data?.find((o) => o.slug === org)?.role ?? null, isPending: false };
}
