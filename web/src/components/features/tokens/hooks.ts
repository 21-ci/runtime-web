import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

// Shape from docs/api-web.md §7. The secret is returned once, on create, and never again.
export type Token = {
  id: string;
  name: string;
  scopes: string[];
  projects: string[]; // project slugs; empty = all projects
  environments: string[]; // empty = all environments
  created_by: { id: string; name: string };
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
};

export type TokenRequest = {
  name: string;
  scopes: string[];
  projects: string[];
  environments: string[];
  expires_at: number | null;
};

export function useTokens(org: string, enabled: boolean) {
  return useQuery({
    queryKey: ["tokens", org],
    queryFn: () => api.get<{ items: Token[] }>(`/orgs/${encodeURIComponent(org)}/tokens`).then((r) => r.items),
    enabled,
  });
}

export function useCreateToken(org: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipGlobalError: true },
    mutationFn: (body: TokenRequest) =>
      api.post<{ token: Token; secret: string }>(`/orgs/${encodeURIComponent(org)}/tokens`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tokens", org] }),
  });
}

export function useRevokeToken(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/orgs/${encodeURIComponent(org)}/tokens/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tokens", org] }),
  });
}
