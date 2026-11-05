import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { i18n } from "@/lib/i18n";

// Shapes from docs/reference/api.md §6.2. No route returns a channel's config.
export type AlertChannel = {
  id: string;
  kind: "webhook" | "telegram" | "email";
  name: string;
  created_at: number;
  last_ok_at: number | null;
  last_error: string | null;
};

export type AlertRule = {
  id: string;
  kind: string;
  app: string | null;
  params: Record<string, number>;
  channels: string[];
  enabled: boolean;
  for_s: number;
  repeat_s: number;
  muted_until: number | null;
  created_at: number;
};

export type ActiveAlert = { rule_id: string; kind: string; subject: string; state: "pending" | "firing"; since: number; value: number | null };

export type ChannelInput =
  | { kind: "webhook"; name: string; config: { url: string; secret: string } }
  | { kind: "telegram"; name: string; config: { bot_token: string; chat_id: string } };

export type RuleInput = { kind: string; channels: string[]; app?: string };

export const ORG_KINDS = ["app_error_rate", "dlq_growth", "build_failed"] as const;
export const INSTANCE_KINDS = ["disk_low", "backup_stale"] as const;

/** The API root of a scope: an org's alerts, or the instance's. */
export const orgAlerts = (org: string) => `/orgs/${encodeURIComponent(org)}/alerts`;
export const instanceAlerts = "/admin/alerts";

const key = (base: string) => ["alerts", base];

export const useChannels = (base: string) =>
  useQuery({ queryKey: [...key(base), "channels"], queryFn: () => api.get<{ items: AlertChannel[] }>(`${base}/channels`) });

export const useRules = (base: string) =>
  useQuery({ queryKey: [...key(base), "rules"], queryFn: () => api.get<{ items: AlertRule[] }>(`${base}/rules`) });

export const useActiveAlerts = (base: string) =>
  useQuery({ queryKey: [...key(base), "active"], queryFn: () => api.get<{ items: ActiveAlert[] }>(`${base}/active`) });

function useWrite<V, R>(base: string, fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => void qc.invalidateQueries({ queryKey: key(base) }) });
}

export const useCreateChannel = (base: string) => useWrite(base, (v: ChannelInput) => api.post<AlertChannel>(`${base}/channels`, v));
export const useDeleteChannel = (base: string) => useWrite(base, (id: string) => api.del<null>(`${base}/channels/${id}`));
export const useCreateRule = (base: string) => useWrite(base, (v: RuleInput) => api.post<AlertRule>(`${base}/rules`, v));
export type RulePatch = { enabled?: boolean; muted_until?: number | null; channels?: string[]; for_s?: number; repeat_s?: number; params?: Record<string, number> };
export type ChannelPatch = { name?: string; config?: ChannelInput["config"] };
export const useUpdateRule = (base: string) => useWrite(base, ({ id, ...v }: RulePatch & { id: string }) => api.patch<AlertRule>(`${base}/rules/${id}`, v));
export const useUpdateChannel = (base: string) => useWrite(base, ({ id, ...v }: ChannelPatch & { id: string }) => api.patch<AlertChannel>(`${base}/channels/${id}`, v));

/** What a rule of each kind can be tuned by, with the bounds of server/src/alerts/rules.ts. */
export const RULE_PARAMS: Record<string, { key: string; fallback: number; min: number; max: number; step?: number }[]> = {
  app_error_rate: [
    { key: "threshold_pct", fallback: 5, min: 0.1, max: 100, step: 0.1 },
    { key: "min_requests", fallback: 100, min: 1, max: 1_000_000 },
  ],
  disk_low: [{ key: "min_free_pct", fallback: 15, min: 1, max: 99 }],
  backup_stale: [{ key: "max_age_h", fallback: 26, min: 1, max: 720 }],
};
export const useDeleteRule = (base: string) => useWrite(base, (id: string) => api.del<null>(`${base}/rules/${id}`));

export function useTestChannel(base: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean; status: string }>(`${base}/channels/${id}/test`),
    onSuccess: (out) => {
      void qc.invalidateQueries({ queryKey: key(base) });
      if (out.ok) toast.success(i18n.t("alerts:channels.testOk"));
      else toast.error(i18n.t("alerts:channels.testFailed", { status: out.status }));
    },
  });
}
