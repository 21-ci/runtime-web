import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

// Shapes from docs/api-web.md §6. Runtime passthroughs (node status, scheduler, cache) are opaque.
export type Json = Record<string, unknown>;

export type DomainRow = {
  id: string;
  host: string;
  app: string;
  status: "pending" | "active" | "failed";
  cert_status: "none" | "pending" | "issued" | "error";
  cert_not_after: number | null;
  cert_error: string | null;
  org: { slug: string; name: string };
};

export type ProviderId = "github" | "google" | "oidc";

export type OAuthProvider = {
  id: ProviderId;
  enabled: boolean;
  client_id: string;
  client_secret_set: boolean;
  issuer?: string;
  name?: string;
};

export type InstanceSettings = {
  public_url: string;
  require_2fa: boolean;
  password_login_disabled: boolean;
  providers: OAuthProvider[];
};

export type InstanceSettingsWrite = {
  require_2fa: boolean;
  password_login_disabled: boolean;
  providers: {
    id: ProviderId;
    enabled: boolean;
    client_id: string;
    issuer?: string;
    name?: string;
    client_secret?: string;
  }[];
};

// NodeConfig is the only node configuration the admin UI edits.
export type NodeConfig = {
  degradation_mode: string;
  default_profile: string;
  rate_limit: Record<string, unknown>;
};

// Form-driven writes show their own field errors, so the global toast is skipped for them.
const inline = { skipGlobalError: true } as const;

export function useNodeStatus() {
  return useQuery({ queryKey: ["admin", "node", "status"], queryFn: () => api.get<Json>("/admin/node/status") });
}

export function useNodeScheduler() {
  return useQuery({ queryKey: ["admin", "node", "scheduler"], queryFn: () => api.get<Json>("/admin/node/scheduler") });
}

export function useNodeCache() {
  return useQuery({ queryKey: ["admin", "node", "cache"], queryFn: () => api.get<Json>("/admin/node/cache") });
}

export function useNodeConfig() {
  return useQuery({ queryKey: ["admin", "node", "config"], queryFn: () => api.get<NodeConfig>("/admin/node/config") });
}

export function useSaveNodeConfig() {
  const qc = useQueryClient();
  return useMutation({
    meta: inline,
    mutationFn: (body: NodeConfig) =>
      api.put<{ applied: string[]; pending_restart: string[] }>("/admin/node/config", body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin", "node", "config"] }),
  });
}

export function useDrainNode() {
  return useMutation({
    mutationFn: () => api.post<Json>("/admin/node/drain", { confirm: "drain" }),
  });
}

export function useAdminDomains() {
  return useQuery({
    queryKey: ["admin", "domains"],
    queryFn: () => api.get<{ items: DomainRow[] }>("/admin/domains").then((r) => r.items),
  });
}

export function useAdminSettings() {
  return useQuery({ queryKey: ["admin", "settings"], queryFn: () => api.get<InstanceSettings>("/admin/settings") });
}

export function useSaveAdminSettings() {
  const qc = useQueryClient();
  return useMutation({
    meta: inline,
    mutationFn: (body: InstanceSettingsWrite) => api.put<InstanceSettings>("/admin/settings", body),
    onSuccess: (data) => qc.setQueryData(["admin", "settings"], data),
  });
}
