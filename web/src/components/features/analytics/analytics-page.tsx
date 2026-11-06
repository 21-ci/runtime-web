import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";

import { pollInterval } from "@/components/features/admin/use-monitoring";
import { appPath } from "@/components/features/app-header/hooks";
import { AppCharts } from "@/components/features/overview/app-charts";
import { useAppStats } from "@/components/features/overview/hooks";
import { ExportMenu } from "@/components/ui/export-menu";
import { NoData } from "@/components/ui/no-data";
import { SectionCard } from "@/components/ui/section-card";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { i18n } from "@/lib/i18n";

import { hourGrid, outcomeSegments } from "./analytics-lib";
import { DumbbellList, HourHeatmap, ShareBar } from "./blocks";
import { BranchCompare } from "./branch-compare";

const RANGES = ["1h", "24h"] as const;
type Range = (typeof RANGES)[number];
type Percentiles = { p50_ms?: number; p95_ms?: number; p99_ms?: number };

const PHASES = ["total", "queue", "init", "exec"] as const;
const ms = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)} ms`;

// An outcome is a runtime code. The common ones have a translation; any other stays readable as it is.
const outcomeLabel = (code: string, known: Record<string, string>) => known[code] ?? code.replace(/_/g, " ");

function Outcomes({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation("monitoring");
  const [range, setRange] = useState<Range>("24h");
  const stats = useAppStats(org, app, range);
  const known = { ok: t("analytics.outcomeOk"), guest_error: t("analytics.outcomeGuestError") };
  const outcomes = stats.data?.outcomes as Record<string, number> | undefined;
  const segments = outcomeSegments(outcomes).map((s) => ({ ...s, label: outcomeLabel(s.key, known) }));
  // A phase the runtime gave no percentiles for is left out: a zero here would read as a measurement.
  const phases = PHASES.flatMap((p) => {
    const v = stats.data?.[p] as Percentiles | undefined;
    return typeof v?.p50_ms === "number" && typeof v.p99_ms === "number" && stats.data?.count
      ? [{ key: p, label: t(`analytics.phase.${p}`), before: v.p50_ms, after: v.p99_ms }]
      : [];
  });
  const switcher = <Segmented label={t("range.label")} value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r, label: t(`range.${r}`) }))} />;
  const exportCsv = <ExportMenu formats={["csv"]} href={(f) => `/api${appPath(org, app)}/stats?format=${f}&window=${range}`} />;
  const empty = <NoData hint={t("analytics.noTraffic")} />;
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
      <SectionCard title={t("analytics.outcomes")} description={t("analytics.outcomesHint")} actions={<>{switcher}{exportCsv}</>}>
        {stats.isPending ? <Skeleton className="h-40 w-full" /> : stats.isError ? <NoData hint={t("node.unavailable")} /> : segments.length ? <ShareBar segments={segments} label={t("analytics.outcomes")} /> : empty}
      </SectionCard>
      <SectionCard title={t("analytics.latency")} description={t("analytics.latencyHint")} actions={switcher}>
        {stats.isPending ? <Skeleton className="h-40 w-full" /> : phases.length ? <DumbbellList rows={phases} beforeLabel="p50" afterLabel="p99" format={ms} /> : empty}
      </SectionCard>
    </div>
  );
}

function RequestHours({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation("monitoring");
  const week = useQuery({
    queryKey: ["app-series", org, app, "7d"],
    queryFn: () => api.get<{ series?: { ts: number; count?: number; errors?: number }[] }>(`${appPath(org, app)}/stats?window=7d`),
    refetchInterval: pollInterval,
    retry: false,
  });
  const points = week.data?.series ?? [];
  const grid = useMemo(() => hourGrid(points), [points]);
  const weekdays = useMemo(() => {
    const f = new Intl.DateTimeFormat(i18n.language, { weekday: "short" });
    // 2026-11-01 is a Sunday.
    return Array.from({ length: 7 }, (_, d) => f.format(new Date(2026, 10, 1 + d)));
  }, []);
  const measured = points.some((p) => p.count !== undefined);
  const busy = grid.flatMap((row, d) => row.flatMap((n, h) => (n > 0 ? [{ d, h, n }] : [])));
  return (
    <SectionCard
      title={t("analytics.requestHours")}
      description={t("analytics.requestHoursHint")}
      actions={<ExportMenu formats={["csv"]} href={(f) => `/api${appPath(org, app)}/stats?format=${f}&window=7d`} />}
    >
      {week.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : measured ? (
        <div className="flex flex-col gap-3">
          <HourHeatmap grid={grid} weekdays={weekdays} label={t("analytics.requestHours")} />
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">{t("chart.table")}</summary>
            <Table className="mt-2 max-h-48">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("analytics.day")}</TableHead>
                  <TableHead>{t("analytics.hour")}</TableHead>
                  <TableHead className="text-right">{t("app.requests")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {busy.map(({ d, h, n }) => (
                  <TableRow key={`${d}-${h}`}>
                    <TableCell>{weekdays[d]}</TableCell>
                    <TableCell className="tabular-nums">{`${String(h).padStart(2, "0")}:00`}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCount(n)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </details>
        </div>
      ) : (
        <NoData hint={t("analytics.noTraffic")} />
      )}
    </SectionCard>
  );
}

// AnalyticsView: every figure comes from the runtime's stats or the console's hourly ring. What the runtime does not
// record has no card.
export function AnalyticsView({ org, app }: { org: string; app: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <AppCharts org={org} app={app} />
      <Outcomes org={org} app={app} />
      <RequestHours org={org} app={app} />
      <BranchCompare org={org} app={app} />
    </div>
  );
}
