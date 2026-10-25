import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { OrgRole } from "@/lib/types";

// Shape from docs/reference/api.md §5.2. Pending invites only.
export type Invite = {
  id: string;
  email: string;
  org: { slug: string; name: string } | null;
  role: OrgRole | null;
  created_by: { id: string; name: string };
  created_at: number;
  expires_at: number;
};

export function useInvites(org: string, enabled: boolean) {
  return useQuery({
    queryKey: ["invites", org],
    queryFn: () => api.get<{ items: Invite[] }>(`/orgs/${encodeURIComponent(org)}/invites`).then((r) => r.items),
    enabled,
  });
}

export function useCreateInvite(org: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipGlobalError: true },
    mutationFn: (body: { email: string; role: OrgRole }) =>
      api.post<{ invite: Invite; link: string }>(`/orgs/${encodeURIComponent(org)}/invites`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invites", org] }),
  });
}

export function useRevokeInvite(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/orgs/${encodeURIComponent(org)}/invites/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invites", org] }),
  });
}
