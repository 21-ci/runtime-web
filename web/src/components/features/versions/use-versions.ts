import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { Switch } from "@/components/features/branches/use-branches";
import type { LogLine } from "@/components/features/logs/use-log-stream";
import { api, ApiError } from "@/lib/api";
import { i18n } from "@/lib/i18n";

// Shapes from docs/reference/api.md §8.1 and §8.2.
export type BuildState = "fetching" | "pending" | "building" | "ready" | "failed";

export type Version = {
  version: number;
  build_state: BuildState;
  live: boolean;
  // Null until a deploy from a URL has fetched its archive.
  source_digest: string | null;
  failure: { code?: string; reason: string; message?: string; diagnostics?: unknown[]; version?: number } | null;
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

export type Migrations = {
  applied: { name: string; sha256: string; applied_at: number; version: number }[];
  pending_for_latest: { name: string; sha256: string }[];
};

export function useMigrations(org: string, app: string) {
  return useQuery({
    queryKey: ["migrations", org, app],
    queryFn: () => api.get<Migrations>(`${base(org, app)}/migrations`),
  });
}

// useDryRun runs a promote's migrations on a copy of the data while the confirm dialog is open. It writes
// nothing to the App, so a query fits, and a copy is costly enough never to repeat by itself.
export function useDryRun(org: string, app: string, version: number | null, enabled: boolean) {
  return useQuery({
    queryKey: ["dry-run", org, app, version],
    enabled: enabled && version !== null,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    queryFn: () => api.post<{ pending_migrations: string[] }>(`${base(org, app)}/live/dry-run`, { version }),
  });
}

export function useVersions(org: string, app: string) {
  return useQuery({
    queryKey: ["versions", org, app],
    queryFn: () => api.get<{ items: Version[] }>(`${base(org, app)}/versions`).then((r) => r.items),
    // Keep polling while a build is in flight so the badge moves to ready or failed.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((v) => v.build_state === "fetching" || v.build_state === "pending" || v.build_state === "building") ? 2000 : false,
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

// usePromote starts the promote and answers with its switch, which the dialog then follows. It sends the app's
// ETag as If-Match; a stale ETag yields 409 stale, which the global mutation handler reports with a reload action.
export function usePromote(org: string, app: string) {
  return useMutation({
    mutationFn: ({ version, etag, closeSockets }: { version: number; etag: string; closeSockets?: boolean }) =>
      api.put<Switch>(`${base(org, app)}/live?async=1`, { version, ...(closeSockets ? { close_sockets: true } : {}) }, { ifMatch: etag }),
  });
}

// usePromoteAndWait is for a button with no dialog to follow the switch in: it settles once the switch has.
export function usePromoteAndWait(org: string, app: string) {
  const qc = useQueryClient();
  const settled = usePromoteSettled(org, app);
  return useMutation({
    mutationFn: async ({ version, etag }: { version: number; etag: string }) => {
      const first = await api.put<Switch>(`${base(org, app)}/live?async=1`, { version }, { ifMatch: etag });
      for (;;) {
        const s = await api.get<Switch>(`${base(org, app)}/switches/${encodeURIComponent(first.id ?? "")}`);
        if (s.state === "failed") throw new ApiError(409, s.error ?? "internal", s.error ?? "internal");
        if (s.state !== "preparing" && s.state !== "migrating") return version;
        await new Promise((r) => setTimeout(r, 1000));
      }
    },
    onSuccess: (version) => {
      qc.setQueryData<AppDetail | undefined>(["app", org, app], (old) => (old ? { ...old, live_version: version } : old));
      settled();
      toast.success(i18n.t("versions:toast.live", { version }));
    },
  });
}

// Run once the switch is past preparing and migrating: the app has a new live version and a new ETag.
export function usePromoteSettled(org: string, app: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["app", org, app] });
    void qc.invalidateQueries({ queryKey: ["versions", org, app] });
    void qc.invalidateQueries({ queryKey: ["migrations", org, app] });
    void qc.invalidateQueries({ queryKey: ["switches", org, app] });
    void qc.invalidateQueries({ queryKey: ["apps", org] });
  };
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
