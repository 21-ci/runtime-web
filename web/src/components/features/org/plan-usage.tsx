import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { QueryError } from "@/components/features/empty/query-error";
import { NoData } from "@/components/ui/no-data";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatBytes, formatCount, formatDuration } from "@/lib/format";
import { intlLocale } from "@/lib/i18n";

import { UsageRows, type UsageRow } from "./usage-rows";

export interface PlanMetric {
  key: string;
  used: number;
  limit: number | null;
  period: string;
}

export interface PlanUsage {
  plan: string | null;
  resets_at: number | string | null;
  metrics: PlanMetric[];
}

// PlanUsagePanel is read-only: what the organization used against each limit of its plan.
export function PlanUsagePanel({ org }: { org: string }) {
  const { t } = useTranslation(["plans", "operator"]);
  const usage = useQuery({
    queryKey: ["plan-usage", org],
    queryFn: () => api.get<PlanUsage>(`/orgs/${encodeURIComponent(org)}/plan-usage`),
    retry: false,
  });
  const data = usage.data;
  const parts = [
    data?.plan ? t("usage.plan", { plan: data.plan }) : null,
    data?.resets_at
      ? t("usage.resets", { when: new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(data.resets_at)) })
      : null,
  ].filter(Boolean);

  return (
    <SectionCard aria-label={t("usage.title")} description={parts.join(" · ") || t("usage.description")}>
      {usage.isError ? (
        <QueryError
          error={usage.error}
          onRetry={() => void usage.refetch()}
          notFoundTitle={t("usage.unavailable")}
          notFoundDescription={t("usage.unavailableHint")}
        />
      ) : !data ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : data.metrics.length === 0 ? (
        <NoData hint={t("usage.empty")} />
      ) : (
        <>
          <UsageRows
            rows={data.metrics.map((m) => metricRow(m, hiddenApps(data.metrics), t))}
            ariaLabel={(label) => t("usage.ariaUsage", { label })}
          />
          <p className="mt-4 text-sm text-muted">{t("operator:plan.capsNote")}</p>
        </>
      )}
    </SectionCard>
  );
}

/** Branches and previews, which the runtime counts as Apps and the App lists leave out. */
function hiddenApps(metrics: PlanMetric[]): number {
  return metrics.filter((m) => m.key === "branches" || m.key === "previews").reduce((sum, m) => sum + m.used, 0);
}

function metricRow(metric: PlanMetric, hidden: number, t: TFunction<["plans", "operator"]>): UsageRow {
  const fmt = metric.key.endsWith("_bytes") ? formatBytes : metric.key === "cpu_ms" ? formatDuration : formatCount;
  const label = metric.key === "cpu_ms" ? t("operator:plan.cpuTime") : t(`usage.metric.${metric.key}`, { defaultValue: metric.key });
  const period = metric.period ? t(`usage.period.${metric.period}`, { defaultValue: metric.period }) : "";
  // The runtime's storage counter stays at 0 whatever the disk holds, so 0 here says nothing.
  const unmetered = metric.key === "storage_bytes" && metric.used === 0;
  const amount = unmetered
    ? metric.limit === null
      ? t("operator:plan.notMetered")
      : t("operator:plan.notMeteredLimit", { limit: fmt(metric.limit) })
    : metric.limit === null
      ? `${fmt(metric.used)} · ${t("usage.unlimited")}`
      : `${t("usage.amount", { used: fmt(metric.used), limit: fmt(metric.limit) })}${period ? ` ${period}` : ""}`;
  // A per-App ceiling is not a level this org fills up; a bar over it only ever looks empty.
  const bar = metric.limit !== null && !unmetered && metric.period !== "per_service";
  const note = unmetered ? t("operator:plan.storageHint") : metric.key === "services" && hidden > 0 ? t("operator:plan.includingHidden", { count: hidden }) : null;
  return { key: metric.key, label, amount, note, used: bar ? metric.used : null, limit: bar ? metric.limit : null };
}
