import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { i18n } from "@/lib/i18n";

export type RangeKey = "1h" | "6h" | "24h" | "7d";
export const RANGES: readonly RangeKey[] = ["1h", "6h", "24h", "7d"];

const POLL_MS = 15_000;

/** Polling stops while the tab is hidden: nobody is looking, and each poll is a call to the node. */
export const pollInterval = (): number | false => (document.hidden ? false : POLL_MS);

export type SeriesPoint = {
  ts: number;
  cpu_pct?: number | null;
  load1?: number | null;
  mem_committed?: number | null;
  disk_free?: number | null;
  rx?: number | null;
  tx?: number | null;
};
export type NodeSeries = { range: string; step_s: number; points: SeriesPoint[]; data_from: number | null };
export type NodeStatsItem = { service: string; tenant: string; slug: string | null; count: number; errors: number; org?: string | null; system?: boolean };
export type NodeEvent = { id: string | number; ts: number; service: string | null; kind: string; data?: unknown; app?: string | null; org?: string | null };
export type NodeHost = {
  uptime_s?: number;
  cpu_pct?: number | null;
  load?: number[] | null;
  disk?: { free_bytes: number; total_bytes: number } | null;
  net?: { rx_bytes_per_s: number; tx_bytes_per_s: number } | null;
};
export type Backup = {
  id: string;
  state: string;
  trigger: string;
  started_at: number;
  bytes: number | null;
  encrypted: boolean;
  failure: { code: string; message: string } | null;
};
export type BackupStatus = {
  enabled: boolean;
  schedule: string;
  last_ok_at: number | null;
  last_failure: { code?: string } | null;
  next_at: number | null;
  running_id: string | null;
  destination: { kind: string; endpoint_host?: string | null; bucket?: string | null } | null;
};

export function useNodeSeries(range: RangeKey) {
  return useQuery({
    queryKey: ["admin", "node", "series", range],
    queryFn: () => api.get<NodeSeries>(`/admin/node/series?range=${range}`),
    refetchInterval: pollInterval,
    retry: false,
  });
}

export function useNodeHost() {
  return useQuery({
    queryKey: ["admin", "node", "host"],
    queryFn: () => api.get<{ host?: NodeHost | null }>("/admin/node/status"),
    refetchInterval: pollInterval,
  });
}

export function useNodeTop() {
  return useQuery({
    queryKey: ["admin", "node", "top"],
    queryFn: () => api.get<{ items: NodeStatsItem[] }>("/admin/node/stats"),
    refetchInterval: pollInterval,
    retry: false,
  });
}

export function useNodeEvents() {
  return useQuery({
    queryKey: ["admin", "node", "events"],
    queryFn: () => api.get<{ items: NodeEvent[] }>("/admin/node/events?limit=50"),
    refetchInterval: pollInterval,
    retry: false,
  });
}

export function useBackupStatus() {
  return useQuery({
    queryKey: ["admin", "backups", "status"],
    queryFn: () => api.get<BackupStatus>("/admin/backups/status"),
    refetchInterval: pollInterval,
    retry: false,
  });
}

export function useBackups() {
  return useQuery({
    queryKey: ["admin", "backups", "list"],
    queryFn: () => api.get<{ items: Backup[] }>("/admin/backups"),
    refetchInterval: pollInterval,
    retry: false,
  });
}

export function useCreateBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ id: string }>("/admin/backups"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "backups"] });
      toast.success(i18n.t("monitoring:backups.started"));
    },
  });
}
