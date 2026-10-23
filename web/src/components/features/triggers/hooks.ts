import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { appPath } from "@/components/features/app-header/hooks";
import { api } from "@/lib/api";

// Shapes from docs/api-web.md §8.3.
export type Schedule = {
  id: string;
  kind: "interval" | "cron";
  cron: string | null;
  every_seconds: number | null;
  timezone: string | null;
  payload: unknown;
  enabled: boolean;
  next_due: number | null;
};

export type ScheduleBody = {
  kind: "interval" | "cron";
  every_seconds?: number;
  cron?: string;
  timezone?: string;
  payload?: unknown;
  enabled?: boolean;
};

export type QueueStats = { depth: number; in_flight: number; oldest_age_ms: number; dlq: number };
export type DlqItem = { id: string; body: unknown; attempts: number; failed_at: number };
export type EnqueueBody = { body: unknown; delay_seconds?: number; dedup_id?: string };

// Trigger mutations show their errors inline (plan_limit, busy with retry), not as global toasts.
const inline = { skipGlobalError: true } as const;

function refreshQueue(qc: QueryClient, org: string, app: string) {
  void qc.invalidateQueries({ queryKey: ["queue", org, app] });
  void qc.invalidateQueries({ queryKey: ["dlq", org, app] });
}

export function useSchedules(org: string, app: string) {
  return useQuery({
    queryKey: ["schedules", org, app],
    queryFn: () => api.get<{ items: Schedule[] }>(`${appPath(org, app)}/schedules`).then((r) => r.items),
  });
}

export function useCreateSchedule(org: string, app: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: inline,
    mutationFn: (body: ScheduleBody) => api.post<Schedule>(`${appPath(org, app)}/schedules`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["schedules", org, app] }),
  });
}

export function useUpdateSchedule(org: string, app: string) {
  const qc = useQueryClient();
  return useMutation({
    // The enable toggle has no inline error slot: failures use the global toast.
    mutationFn: ({ id, body }: { id: string; body: Partial<ScheduleBody> }) =>
      api.patch<Schedule>(`${appPath(org, app)}/schedules/${encodeURIComponent(id)}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["schedules", org, app] }),
  });
}

export function useDeleteSchedule(org: string, app: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: inline,
    mutationFn: (id: string) => api.del<void>(`${appPath(org, app)}/schedules/${encodeURIComponent(id)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["schedules", org, app] }),
  });
}

export function useQueueStats(org: string, app: string) {
  return useQuery({
    queryKey: ["queue", org, app],
    queryFn: () => api.get<QueueStats>(`${appPath(org, app)}/queue`),
  });
}

export function useEnqueue(org: string, app: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: inline,
    mutationFn: (body: EnqueueBody) => api.post<{ id: string }>(`${appPath(org, app)}/queue`, body),
    onSuccess: () => refreshQueue(qc, org, app),
  });
}

export function useDlq(org: string, app: string) {
  return useQuery({
    queryKey: ["dlq", org, app],
    queryFn: () => api.get<{ items: DlqItem[] }>(`${appPath(org, app)}/dlq`).then((r) => r.items),
  });
}

export function usePurgeDlq(org: string, app: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: inline,
    mutationFn: () => api.del<void>(`${appPath(org, app)}/dlq`),
    onSuccess: () => refreshQueue(qc, org, app),
  });
}

export function useRedriveDlq(org: string, app: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: inline,
    mutationFn: () => api.post<{ redriven: number }>(`${appPath(org, app)}/dlq/redrive`),
    onSuccess: () => refreshQueue(qc, org, app),
  });
}
