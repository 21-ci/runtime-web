import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useOrgs, useProjects, type AppSummary } from "@/hooks/orgs";
import { api } from "@/lib/api";

// Shapes from docs/api-web.md §1.4, §8.1 and §8.2.
export type AppView = AppSummary & { etag: string; runtime: string; url: string };
export type Diagnostic = { file?: string; line?: number; column?: number; message: string; severity?: string };
export type BuildDetails = { reason: string; message: string; diagnostics?: Diagnostic[]; version?: number };
export type Files = {
  version: number;
  entry: string;
  files: Record<string, string>;
  read_only: boolean;
  kind: "ts" | "js" | "bundle" | "wasm";
};
export type Version = {
  version: number;
  build_state: "pending" | "building" | "ready" | "failed";
  live: boolean;
  failure: BuildDetails | null;
};

const enc = encodeURIComponent;
const appPath = (org: string, app: string) => `/orgs/${enc(org)}/apps/${enc(app)}`;

export function useAppView(org: string, app: string) {
  return useQuery({ queryKey: ["app", org, app], queryFn: () => api.get<AppView>(appPath(org, app)) });
}

export function useFiles(org: string, app: string) {
  return useQuery({
    queryKey: ["files", org, app],
    queryFn: () => api.get<Files>(`${appPath(org, app)}/files`),
    // A background refetch must never replace the text being edited.
    refetchOnWindowFocus: false,
  });
}

// useVersion polls one version until its build settles (a save normally returns it ready).
export function useVersionState(org: string, app: string, version: number | null) {
  return useQuery({
    queryKey: ["versions", org, app],
    queryFn: () => api.get<{ items: Version[] }>(`${appPath(org, app)}/versions`).then((r) => r.items),
    enabled: version !== null,
    select: (items) => items.find((v) => v.version === version),
    refetchInterval: (q) => {
      const v = q.state.data?.find((x) => x.version === version);
      return v && (v.build_state === "pending" || v.build_state === "building") ? 2000 : false;
    },
  });
}

export function useSaveFiles(org: string, app: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipGlobalError: true }, // CodePage shows stale, build failures and other errors itself
    mutationFn: (v: { entry: string; files: Record<string, string>; etag: string }) =>
      api.put<{ version: Version; etag: string }>(
        `${appPath(org, app)}/files`,
        { entry: v.entry, files: v.files },
        { ifMatch: v.etag },
      ),
    onSuccess: (res) => {
      qc.setQueryData<AppView>(["app", org, app], (old) =>
        old ? { ...old, etag: res.etag, live_version: res.version.live ? res.version.version : old.live_version } : old,
      );
      void qc.invalidateQueries({ queryKey: ["versions", org, app] });
      void qc.invalidateQueries({ queryKey: ["apps", org] });
    },
  });
}

// useCanDeploy: org owners/admins and project admins/developers may save (app.deploy).
export function useCanDeploy(org: string, project: string | undefined): boolean | undefined {
  const orgs = useOrgs();
  const projects = useProjects(org);
  const orgRole = orgs.data?.find((o) => o.slug === org)?.role;
  if (orgRole === "owner" || orgRole === "admin") return true;
  if (!projects.data || !project) return orgs.isPending || projects.isPending ? undefined : false;
  const role = projects.data.find((p) => p.slug === project)?.role;
  return role === "admin" || role === "developer";
}
