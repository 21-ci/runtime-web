import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { i18n } from "@/lib/i18n";

// Shapes from docs/reference/api.md §8.2.1.
export type Branch = {
  name: string;
  slug: string;
  url: string;
  build_state: string;
  live_version: number | null;
  digest: string | null;
  expires_at: number | null;
};

export type SwitchState = "preparing" | "migrating" | "draining" | "completed" | "drain_timed_out" | "failed";

export type Switch = {
  id: string | null;
  kind: "promote" | "switch" | "rollback";
  state: SwitchState;
  from_version: number | null;
  to_version: number | null;
  source: { version: number; digest: string | null } | null;
  inflight_old: number;
  drain_deadline: number | null;
  interrupted: boolean;
  error: string | null;
  warnings: { code: string; names: string[] }[];
  pending_migrations: string[] | null;
  dry_run: boolean;
  created_at: number;
  updated_at: number;
};

// A drain can outlast any one request, so progress comes from short polls, never one held connection.
const POLL_MS = 2000;

export const isActive = (s: SwitchState) => s === "preparing" || s === "migrating" || s === "draining";

const base = (org: string, app: string) => `/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}`;

export function useBranches(org: string, app: string) {
  return useQuery({
    queryKey: ["branches", org, app],
    queryFn: () => api.get<{ items: Branch[] }>(`${base(org, app)}/branches`).then((r) => r.items),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((b) => b.build_state === "pending" || b.build_state === "building") ? POLL_MS : false,
  });
}

export function useSwitches(org: string, app: string) {
  return useQuery({
    queryKey: ["switches", org, app],
    queryFn: () => api.get<{ items: Switch[] }>(`${base(org, app)}/switches`).then((r) => r.items),
    refetchInterval: (q) => ((q.state.data ?? []).some((s) => isActive(s.state)) ? POLL_MS : false),
  });
}

// usePreflight asks the runtime what a switch would do. It writes nothing, so it runs as a query that
// is never cached: the answer must describe the moment the dialog opened.
export function usePreflight(org: string, app: string, branch: string | null) {
  return useQuery({
    queryKey: ["switch-preflight", org, app, branch],
    queryFn: () => api.post<Switch>(`${base(org, app)}/switch`, { branch, dry_run: true }),
    enabled: branch !== null,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useSwitchStatus(org: string, app: string, id: string | null) {
  return useQuery({
    queryKey: ["switch", org, app, id],
    queryFn: () => api.get<Switch>(`${base(org, app)}/switches/${encodeURIComponent(id ?? "")}`),
    enabled: id !== null,
    refetchInterval: (q) => (q.state.data && !isActive(q.state.data.state) ? false : POLL_MS),
  });
}

function afterFlip(qc: ReturnType<typeof useQueryClient>, org: string, app: string) {
  void qc.invalidateQueries({ queryKey: ["app", org, app] });
  void qc.invalidateQueries({ queryKey: ["versions", org, app] });
  void qc.invalidateQueries({ queryKey: ["switches", org, app] });
  void qc.invalidateQueries({ queryKey: ["apps", org] });
}

export function useSwitch(org: string, app: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { branch: string; closeSockets: boolean; etag: string }) =>
      api.post<Switch>(`${base(org, app)}/switch`, { branch: v.branch, close_sockets: v.closeSockets }, { ifMatch: v.etag }),
    onSuccess: (res) => {
      afterFlip(qc, org, app);
      toast.success(i18n.t("branches:toast.switched", { version: res.to_version }));
    },
  });
}

export function useRollback(org: string, app: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; etag: string }) =>
      api.post<Switch>(`${base(org, app)}/switches/${encodeURIComponent(v.id)}/rollback`, undefined, { ifMatch: v.etag }),
    onSuccess: (res) => {
      afterFlip(qc, org, app);
      toast.success(i18n.t("branches:toast.rolledBack", { version: res.to_version }));
    },
  });
}
