import { Activity } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { topSegments } from "@/components/features/analytics/analytics-lib";
import { RankedList } from "@/components/features/analytics/blocks";
import { ExportMenu } from "@/components/ui/export-menu";
import { NoData } from "@/components/ui/no-data";
import { MetricPlane, type PlaneMetric } from "@/components/features/analytics/metric-plane";
import { SectionCard } from "@/components/ui/section-card";
import { Timeline } from "@/components/ui/timeline";
import { StatTile, type StatTone } from "@/components/ui/stat-tile";
import { Badge } from "@/components/ui/badge";
import { EventDetails } from "@/components/features/deployments/events-panel";
import { eventNote, groupEvents, groupTitle } from "@/components/features/deployments/event-text";
import { formatBytes, formatDateTime } from "@/lib/format";

import { RangeSwitch } from "./range-switch";
import { RANGES, useNodeEvents, useNodeHost, useNodeSeries, useNodeTop, type NodeEvent, type RangeKey, type SeriesPoint } from "./use-monitoring";

// The node page shows the latest; the instance audit log is the full history.
const ACTIVITY_ITEMS = 10;

const CHARTS: { key: keyof Omit<SeriesPoint, "ts">; label: string; bytes: boolean }[] = [
  { key: "cpu_pct", label: "cpu", bytes: false },
  { key: "load1", label: "load", bytes: false },
  { key: "mem_committed", label: "memory", bytes: true },
  { key: "disk_free", label: "diskFree", bytes: true },
  { key: "rx", label: "rx", bytes: true },
  { key: "tx", label: "tx", bytes: true },
];

function uptime(s: number): string {
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`;
}

const pctTone = (pct: number | null | undefined): StatTone => (pct == null || pct < 75 ? "neutral" : pct < 90 ? "warning" : "danger");

// NodeMonitor: the node's figures for instance admins. Everything here is fetched from /api/admin/*, which the
// server refuses to anyone else; none of it is ever reachable from an org's pages.
export function NodeMonitor({ activityLink }: { activityLink?: ReactNode }) {
  const { t } = useTranslation(["monitoring", "operator", "common"]);
  const [range, setRange] = useState<RangeKey>("1h");
  const series = useNodeSeries(range);
  const status = useNodeHost();
  const top = useNodeTop();
  const events = useNodeEvents();
  const host = status.data?.host;
  const labels = { noData: t("chart.noData"), table: t("chart.table"), time: t("chart.time"), value: t("chart.value") };
  const dash = t("common:na");
  const points = series.data?.points ?? [];
  const metrics: PlaneMetric[] = CHARTS.map((c) => {
    const format = c.bytes ? formatBytes : (v: number) => String(Math.round(v * 100) / 100);
    const last = [...points].reverse().find((p) => p[c.key] != null)?.[c.key];
    return {
      key: c.key,
      label: t(`node.${c.label}` as "node.cpu"),
      value: last != null ? format(last) : dash,
      points: points.map((p) => ({ ts: p.ts, value: p[c.key] ?? null })),
      format,
      max: c.key === "disk_free" ? host?.disk?.total_bytes : undefined,
    };
  });
  const diskUsed = host?.disk?.total_bytes ? Math.round((1 - host.disk.free_bytes / host.disk.total_bytes) * 100) : null;
  const topItems = top.data?.items ?? [];
  const byService = new Map(topItems.map((s) => [s.service, s]));
  const segments = topSegments(topItems.map((s) => ({ key: s.service, label: s.slug ?? s.service, value: s.count })), 10, t("node.other"));

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SectionCard title={t("node.title")} actions={<RangeSwitch ranges={RANGES} value={range} onChange={setRange} />}>
        {host ? (
          <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <StatTile label={t("node.uptime")} value={host.uptime_s != null ? uptime(host.uptime_s) : dash} />
            <StatTile
              label={t("node.diskFree")}
              value={host.disk ? formatBytes(host.disk.free_bytes) : dash}
              tone={pctTone(diskUsed)}
              hint={diskUsed !== null ? t("node.diskUsed", { pct: diskUsed }) : undefined}
            />
          </dl>
        ) : null}
        {series.isError ? (
          <NoData hint={t("node.unavailable")} />
        ) : (
          <>
            <MetricPlane metrics={metrics} labels={labels} label={t("analytics.plane")} />
            <p className="mt-3 text-xs text-muted">
              {series.data?.data_from ? `${t("chart.dataFrom", { time: formatDateTime(series.data.data_from) })} ` : ""}
              {range !== "7d" ? t("chart.restart") : ""}
            </p>
          </>
        )}
      </SectionCard>

      <div className="flex min-w-0 flex-col gap-4">
        <SectionCard title={t("node.top")} bounded>
          {segments.length === 0 ? (
            <NoData hint={t("node.topEmpty")} />
          ) : (
            <RankedList
              segments={segments}
              label={t("node.top")}
              extra={(seg) => {
                const s = byService.get(seg.key);
                if (!s) return null;
                return (
                  <>
                    {s.system ? <Badge className="ml-2" title={t("operator:node.systemHint")}>{t("operator:node.system")}</Badge> : null}
                    {s.errors > 0 ? <span className="ml-2 text-xs tabular-nums text-danger-text">{t("node.errorCount", { n: s.errors })}</span> : null}
                  </>
                );
              }}
            />
          )}
        </SectionCard>
        <SectionCard
          title={t("node.events")}
          actions={<ExportMenu name="node-events" rows={(events.data?.items ?? []) as unknown as Record<string, unknown>[]} />}
        >
          {(events.data?.items.length ?? 0) === 0 ? (
            <NoData hint={t("node.eventsEmpty")} />
          ) : (
            <>
              <Timeline
                items={groupEvents([...(events.data?.items ?? [])].reverse()).slice(0, ACTIVITY_ITEMS).map((g) => {
                  const e = g.events[g.events.length - 1] as NodeEvent;
                  const note = g.change ? null : eventNote(e);
                  return {
                    id: g.key,
                    icon: Activity,
                    title: (
                      <>
                        <span className="font-medium">{e.app ?? (e.service ? t("operator:events.unknownApp") : t("operator:events.nodeWide"))}</span>
                        {": "}
                        {groupTitle(g)}
                        {note ? <span className="text-muted"> ({note})</span> : null}
                      </>
                    ),
                    at: g.ts,
                    detail: <EventDetails value={e} />,
                  };
                })}
              />
              {activityLink ? <div className="pt-2 text-[13px]">{activityLink}</div> : null}
            </>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
