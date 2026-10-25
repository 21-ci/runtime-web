import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { LogLine } from "@/components/features/logs/use-log-stream";
import { api } from "@/lib/api";
import { i18n } from "@/lib/i18n";

// Shapes from docs/reference/api.md §8.1 and §8.2.
export type BuildState = "pending" | "building" | "ready" | "failed";

export type Version = {
  version: number;
  build_state: BuildState;
  live: boolean;
  source_digest: string;
  failure: { reason: string; diagnostics?: unknown[]; version?: number } | null;
  author: { user_id: string; name: string } | null; // null = made outside the web
  created_at: number;
};

export type AppDetail = {
  slug: string;
  project: string;
  name: string | null;
  live_version: number | null;
  etag: string;
};

export type Files = {
  version: number;
  entry: string;
  files: Record<string, string>;
  read_only: boolean;
  kind: "ts" | "js" | "bundle" | "wasm";
};

export type BuildLines = { items: LogLine[] };

const base = (org: string, app: string) => `/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}`;

export function useAppDetail(org: string, app: string) {
  return useQuery({
    queryKey: ["app", org, app],
    queryFn: () => api.get<AppDetail & { etag: string }>(base(org, app)),
  });
}

export function useVersions(org: string, app: string) {
  return useQuery({
    queryKey: ["versions", org, app],
    queryFn: () => api.get<{ items: Version[] }>(`${base(org, app)}/versions`).then((r) => r.items),
    // Keep polling while a build is in flight so the badge moves to ready or failed.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((v) => v.build_state === "pending" || v.build_state === "building") ? 2000 : false,
  });
}

export function useBuildLog(org: string, app: string, version: number, enabled: boolean) {
  return useQuery({
    queryKey: ["build-logs", org, app, version],
    queryFn: () => api.get<BuildLines>(`${base(org, app)}/versions/${version}/build-logs`).then((r) => r.items),
    enabled,
  });
}

// useFiles reads one version's source; undefined means the live version.
export function useFiles(org: string, app: string, version: number | undefined, enabled: boolean) {
  const qs = version === undefined ? "" : `?version=${version}`;
  return useQuery({
    queryKey: ["files", org, app, version ?? "live"],
    queryFn: () => api.get<Files>(`${base(org, app)}/files${qs}`),
    enabled,
  });
}

// usePromote sets the live version. It sends the app's ETag as If-Match; a stale ETag yields 409 stale,
// which the global mutation handler reports with a reload action.
export function usePromote(org: string, app: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ version, etag }: { version: number; etag: string }) =>
      api.put<{ live_version: number; etag: string }>(`${base(org, app)}/live`, { version }, { ifMatch: etag }),
    onSuccess: (res) => {
      qc.setQueryData<AppDetail | undefined>(["app", org, app], (old) =>
        old ? { ...old, live_version: res.live_version, etag: res.etag } : old,
      );
      void qc.invalidateQueries({ queryKey: ["versions", org, app] });
      void qc.invalidateQueries({ queryKey: ["apps", org] });
      toast.success(i18n.t("versions:toast.live", { version: res.live_version }));
    },
  });
}

export function useRebuild(org: string, app: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (version: number) => api.post<Version>(`${base(org, app)}/versions/${version}/rebuild`),
    onSuccess: (_res, version) => {
      void qc.invalidateQueries({ queryKey: ["versions", org, app] });
      void qc.invalidateQueries({ queryKey: ["build-logs", org, app, version] });
      toast.success(i18n.t("versions:toast.rebuilding", { version }));
    },
  });
}
