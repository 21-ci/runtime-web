import { useState } from "react";
import { useTranslation } from "react-i18next";

import { LineChart } from "@/components/ui/line-chart";
import { SectionCard } from "@/components/ui/section-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBytes } from "@/lib/chart";
import { formatDateTime } from "@/lib/format";

import { RangeSwitch } from "./range-switch";
import { RANGES, useNodeEvents, useNodeHost, useNodeSeries, useNodeTop, type RangeKey, type SeriesPoint } from "./use-monitoring";

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

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

// NodeMonitor: the node's figures for instance admins. Everything here is fetched from /api/admin/*, which the
// server refuses to anyone else; none of it is ever reachable from an org's pages.
export function NodeMonitor() {
  const { t } = useTranslation("monitoring");
  const [range, setRange] = useState<RangeKey>("1h");
  const series = useNodeSeries(range);
  const status = useNodeHost();
  const top = useNodeTop();
  const events = useNodeEvents();
  const host = status.data?.host;
  const labels = { noData: t("chart.noData"), table: t("chart.table"), time: t("chart.time"), value: t("chart.value") };
  const dash = "–";

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SectionCard title={t("node.title")} actions={<RangeSwitch ranges={RANGES} value={range} onChange={setRange} />}>
        {host ? (
          <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Tile label={t("node.uptime")} value={host.uptime_s != null ? uptime(host.uptime_s) : dash} />
            <Tile label={t("node.cpu")} value={host.cpu_pct != null ? host.cpu_pct.toFixed(1) : dash} />
            <Tile label={t("node.load")} value={host.load?.[0] != null ? host.load[0].toFixed(2) : dash} />
            <Tile label={t("node.diskFree")} value={host.disk ? formatBytes(host.disk.free_bytes) : dash} />
            <Tile label={t("node.rx")} value={host.net ? `${formatBytes(host.net.rx_bytes_per_s)}/s` : dash} />
            <Tile label={t("node.tx")} value={host.net ? `${formatBytes(host.net.tx_bytes_per_s)}/s` : dash} />
          </dl>
        ) : null}
        {series.isError ? (
          <p className="text-sm text-muted">{t("node.unavailable")}</p>
        ) : (
          <>
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
              {CHARTS.map((c) => (
                <LineChart
                  key={c.key}
                  title={t(`node.${c.label}` as "node.cpu")}
                  labels={labels}
                  points={(series.data?.points ?? []).map((p) => ({ ts: p.ts, value: p[c.key] ?? null }))}
                  {...(c.bytes ? { format: formatBytes } : {})}
                />
              ))}
            </div>
            <p className="mt-3 text-xs text-muted">
              {series.data?.data_from ? `${t("chart.dataFrom", { time: formatDateTime(series.data.data_from) })} ` : ""}
              {range !== "7d" ? t("chart.restart") : ""}
            </p>
          </>
        )}
      </SectionCard>

      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <SectionCard title={t("node.top")} flush>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("node.slug")}</TableHead>
                <TableHead className="text-right">{t("node.requests")}</TableHead>
                <TableHead className="text-right">{t("node.errors")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...(top.data?.items ?? [])].sort((a, b) => b.count - a.count).slice(0, 10).map((s) => (
                <TableRow key={s.service}>
                  <TableCell className="break-all">{s.slug ?? s.service}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.count}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.errors}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SectionCard>
        <SectionCard title={t("node.events")}>
          {(events.data?.items.length ?? 0) === 0 ? (
            <p className="text-sm text-muted">{t("node.eventsEmpty")}</p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-1 overflow-auto text-sm">
              {[...(events.data?.items ?? [])].reverse().map((e) => (
                <li key={String(e.id)} className="flex justify-between gap-3">
                  <span className="break-all">{e.kind}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted">{formatDateTime(e.ts)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
