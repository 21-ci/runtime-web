import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { appPath } from "@/components/features/app-header/hooks";
import { pollInterval } from "@/components/features/admin/use-monitoring";
import { MetricPlane, type PlaneMetric } from "@/components/features/analytics/metric-plane";
import { EmptyState } from "@/components/ui/empty-state";
import { ExportMenu } from "@/components/ui/export-menu";
import { SectionCard } from "@/components/ui/section-card";
import { Segmented } from "@/components/ui/segmented";
import { api } from "@/lib/api";
import { formatCount, formatDateTime } from "@/lib/format";

type Range = "1h" | "24h" | "7d";
const RANGES: readonly Range[] = ["1h", "24h", "7d"];
const QUERY: Record<Range, string> = { "1h": "window=1h&step=1m", "24h": "window=24h&step=5m", "7d": "window=7d" };

type Point = { ts: number; count?: number; errors?: number; total_p95?: number | null; queue_p95?: number | null; init_p95?: number | null; exec_p95?: number | null };
type Series = { series?: Point[]; data_from?: number | null };

const peak = (values: (number | null | undefined)[]) => {
  const known = values.filter((v): v is number => v != null);
  return known.length ? String(Math.round(Math.max(...known))) : null;
};

// AppCharts: this App's traffic. Org members reach it through the App's own stats route, under the org's tenant
// key, so nothing here can name another tenant's service. The export is that same route with format=csv.
export function AppCharts({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation(["monitoring", "common"]);
  const [range, setRange] = useState<Range>("1h");
  const q = useQuery({
    queryKey: ["app-series", org, app, range],
    queryFn: () => api.get<Series>(`${appPath(org, app)}/stats?${QUERY[range]}`),
    refetchInterval: pollInterval,
    retry: false,
  });
  const points = q.data?.series ?? [];
  const labels = { noData: t("chart.noData"), table: t("chart.table"), time: t("chart.time"), value: t("chart.value") };
  const line = (pick: (p: Point) => number | null | undefined) => points.map((p) => ({ ts: p.ts, value: pick(p) ?? null }));
  const na = t("common:na");
  const requests = points.reduce((sum, p) => sum + (p.count ?? 0), 0);
  const errors = points.reduce((sum, p) => sum + (p.errors ?? 0), 0);
  const rate = requests > 0 ? (errors / requests) * 100 : null;
  const metrics: PlaneMetric[] = [
    { key: "requests", label: t("app.requests"), value: points.length ? formatCount(requests) : na, points: line((p) => p.count) },
    { key: "errors", label: t("app.errors"), value: points.length ? formatCount(errors) : na, points: line((p) => p.errors) },
    {
      key: "rate",
      label: t("app.errorRate"),
      value: rate === null ? na : `${rate.toFixed(rate < 10 ? 2 : 1)}%`,
      tone: rate === null || rate < 1 ? "neutral" : rate < 5 ? "warning" : "danger",
      points: line((p) => (p.count ? ((p.errors ?? 0) / p.count) * 100 : null)),
    },
  ];
  // The week view has no percentiles, so these rows exist only when the points carry them.
  const phases = [
    ["total_p95", t("app.p95")],
    ["queue_p95", t("app.queueP95")],
    ["init_p95", t("app.initP95")],
    ["exec_p95", t("app.execP95")],
  ] as const;
  for (const [key, label] of phases) {
    const value = peak(points.map((p) => p[key]));
    if (value !== null) metrics.push({ key, label, value, points: line((p) => p[key]) });
  }
  return (
    <SectionCard
      title={t("app.title")}
      actions={
        <>
          <Segmented label={t("range.label")} value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r, label: t(`range.${r}`) }))} />
          <ExportMenu formats={["csv"]} href={(f) => `/api${appPath(org, app)}/stats?format=${f}&${QUERY[range]}`} />
        </>
      }
    >
      {q.isError ? (
        <EmptyState variant="error" title={t("app.unavailable")} onRetry={() => void q.refetch()} />
      ) : (
        <MetricPlane metrics={metrics} labels={labels} label={t("analytics.plane")} />
      )}
      {range === "7d" ? (
        <p className="mt-3 text-xs text-muted">
          {t("app.weekNote")} {q.data?.data_from ? t("chart.dataFrom", { time: formatDateTime(q.data.data_from) }) : ""}
        </p>
      ) : null}
    </SectionCard>
  );
}
