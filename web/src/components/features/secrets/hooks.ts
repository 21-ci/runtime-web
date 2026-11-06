import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

// Secrets are write-only: the list carries names and timestamps, never values (docs/reference/api.md §8.3).
export type SecretMeta = {
  name: string;
  updated_at: number;
  source?: "plain" | "vault";
  last_synced_at?: number | null;
  last_error?: string | null;
};

function base(org: string, app: string) {
  return `/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}`;
}

export function useSecrets(org: string, app: string) {
  return useQuery({
    queryKey: ["secrets", org, app],
    queryFn: () => api.get<{ items: SecretMeta[] }>(`${base(org, app)}/secrets`).then((r) => r.items),
  });
}

export function useSaveSecret(org: string, app: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, value }: { name: string; value: string }) =>
      api.put<void>(`${base(org, app)}/secrets/${encodeURIComponent(name)}`, { value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["secrets", org, app] }),
  });
}

export function useDeleteSecret(org: string, app: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.del<void>(`${base(org, app)}/secrets/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["secrets", org, app] }),
  });
}

function useSecretsMutation<V>(org: string, app: string, mutationFn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => qc.invalidateQueries({ queryKey: ["secrets", org, app] }) });
}

export function useLinkSecret(org: string, app: string) {
  return useSecretsMutation(org, app, ({ name, path, field }: { name: string; path: string; field: string }) =>
    api.put<unknown>(`${base(org, app)}/secrets/${encodeURIComponent(name)}/ref`, { path, field }),
  );
}

export function useUnlinkSecret(org: string, app: string) {
  return useSecretsMutation(org, app, (name: string) => api.del<void>(`${base(org, app)}/secrets/${encodeURIComponent(name)}/ref`));
}

export function useSyncSecrets(org: string, app: string) {
  return useSecretsMutation(org, app, () => api.post<unknown>(`${base(org, app)}/secrets/sync`));
}
