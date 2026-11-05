import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { i18n } from "@/lib/i18n";

// Shapes from docs/reference/api.md §8.2.2.
export type GitRule = { ref_pattern: string; branch_name: string; auto_switch: boolean; paused: boolean };

export type GitLink = {
  provider: "github" | "gitlab" | "gitea";
  base_url: string;
  repo: string;
  branch: string;
  subdir: string | null;
  auto_promote: boolean;
  paused: boolean;
  hook_id: string;
  has_token: boolean;
  previews?: boolean;
  webhook_url: string;
};

export type GitDelivery = {
  ref: string;
  sha: string;
  head_sha: string | null;
  state: "queued" | "resolving" | "building" | "deployed" | "skipped" | "failed";
  version: number | null;
  error: string | null;
  target_branch: string | null;
  received_at: number;
};

export type GitView = { link: GitLink | null; rules: GitRule[]; deliveries: GitDelivery[] };

export type GitLinkInput = {
  provider: GitLink["provider"];
  base_url: string;
  repo: string;
  branch: string;
  auto_promote: boolean;
  subdir?: string;
  token?: string;
};

export type GitLinkCreated = GitLink & { hook_secret: string };

const POLL_MS = 5000;
const path = (org: string, app: string) => `/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}/git`;
const key = (org: string, app: string) => ["git", org, app];
const inFlight = (d: GitDelivery) => d.state === "queued" || d.state === "resolving" || d.state === "building";

export function useGit(org: string, app: string, enabled: boolean) {
  return useQuery({
    queryKey: key(org, app),
    queryFn: () => api.get<GitView>(path(org, app)),
    enabled,
    refetchInterval: (q) => ((q.state.data?.deliveries ?? []).some(inFlight) ? POLL_MS : false),
  });
}

function useGitWrite<V, R>(org: string, app: string, fn: (v: V) => Promise<R>, message: "saved" | "deleted" | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key(org, app) });
      if (message) toast.success(i18n.t(`git:toast.${message}`));
    },
  });
}

export const useCreateGitLink = (org: string, app: string) =>
  useGitWrite(org, app, (v: GitLinkInput) => api.post<GitLinkCreated>(path(org, app), v), null);

export const useUpdateGitLink = (org: string, app: string) =>
  useGitWrite(org, app, (v: { paused?: boolean; auto_promote?: boolean; previews?: boolean }) => api.patch<GitLink>(path(org, app), v), "saved");

export const useDeleteGitLink = (org: string, app: string) =>
  useGitWrite(org, app, () => api.del<null>(path(org, app)), "deleted");

export const usePutGitRules = (org: string, app: string) =>
  useGitWrite(org, app, (rules: GitRule[]) => api.put<{ rules: GitRule[] }>(`${path(org, app)}/rules`, { rules }), "saved");
