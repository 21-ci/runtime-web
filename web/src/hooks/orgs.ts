import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { OrgRole } from "@/lib/types";

// Shapes from docs/reference/api.md §2 and §8.1. Timestamps are unix milliseconds.
export type Org = { id: string; slug: string; name: string; created_at: number; role: OrgRole | null };
export type Project = {
  slug: string;
  name: string;
  environments: string[];
  created_at: number;
  updated_at: number;
  role: "admin" | "developer" | "viewer";
};
export type AppSummary = {
  slug: string;
  name: string | null;
  project: string;
  environment: string;
  live_version: number | null;
  status: { build_state: string; tier: string; last_error: string | null };
};
export type Quota = { limit: number | null; used: number; remaining: number | null; period: string };
export type Limits = {
  day: string;
  resets_at: number;
  invocations: Quota;
  egress_bytes: Quota;
  storage_bytes: Quota;
  services: Quota;
  schedules: Quota;
};
export type Usage = {
  app: string | null;
  day: string;
  invocations: number;
  cpu_ms: number;
  egress_bytes: number;
  storage_bytes: number;
};
export type Template = "http" | "cron" | "queue" | "sqlite-crud";

export function useOrgs() {
  return useQuery({
    queryKey: ["orgs"],
    queryFn: () => api.get<{ items: Org[] }>("/orgs").then((r) => r.items),
  });
}

export function useProjects(org: string) {
  return useQuery({
    queryKey: ["projects", org],
    queryFn: () => api.get<{ items: Project[] }>(`/orgs/${enc(org)}/projects`).then((r) => r.items),
  });
}

export function useEnvironments(org: string, project: string) {
  return useQuery({
    queryKey: ["environments", org, project],
    queryFn: () =>
      api.get<{ items: string[] }>(`/orgs/${enc(org)}/projects/${enc(project)}/environments`).then((r) => r.items),
    enabled: project !== "",
  });
}

// useApps lists apps for the org, optionally filtered to one project (first page only in v1 UI).
export function useApps(org: string, project?: string) {
  return useQuery({
    queryKey: ["apps", org, project ?? "*"],
    queryFn: () => {
      const q = project ? `?project=${enc(project)}&limit=200` : "?limit=200";
      return api.get<{ items: AppSummary[] }>(`/orgs/${enc(org)}/apps${q}`).then((r) => r.items);
    },
  });
}

export function useLimits(org: string) {
  return useQuery({
    queryKey: ["limits", org],
    queryFn: () => api.get<Limits>(`/orgs/${enc(org)}/limits`),
  });
}

// useUsage is only called for owners and admins (the card is hidden for members).
export function useUsage(org: string, enabled: boolean) {
  return useQuery({
    queryKey: ["usage", org],
    queryFn: () => api.get<{ items: Usage[] }>(`/orgs/${enc(org)}/usage`).then((r) => r.items),
    enabled,
  });
}

export function useCreateProject(org: string) {
  const qc = useQueryClient();
  return useMutation({
    // The form decides what to toast (field errors inline, others via handleMutationError).
    meta: { skipGlobalError: true },
    mutationFn: (body: { slug: string; name?: string; environments: string[] }) =>
      api.post<Project>(`/orgs/${enc(org)}/projects`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects", org] }),
  });
}

export type CreateAppInput = {
  project: string;
  environment: string;
  slug: string;
  template: Template;
  name?: string;
};

export function useCreateApp(org: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipGlobalError: true },
    mutationFn: (body: CreateAppInput) => api.post<AppSummary>(`/orgs/${enc(org)}/apps`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["apps", org] }),
  });
}

function enc(s: string) {
  return encodeURIComponent(s);
}
