import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useBranches } from "@/components/features/branches/use-branches";
import { useAppStats, type AppStats } from "@/components/features/overview/hooks";
import { ExportMenu } from "@/components/ui/export-menu";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCount } from "@/lib/format";

import { compareProportions } from "./analytics-lib";
import { DumbbellList, IntervalBar } from "./blocks";

const RANGES = ["1h", "24h"] as const;
type Range = (typeof RANGES)[number];

// Below this a 95% interval from the normal approximation means little, so the page does not offer a verdict.
const MIN_COUNT = 30;

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const signedPoints = (v: number) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(2)}`;
const ms = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)} ms`;
const num = (v: unknown) => (typeof v === "number" ? v : 0);

// BranchCompare: an App against one of its branches, over the same window (comparison-02 and comparison-04).
// A branch is its own App on the node, so its figures are its own. Versions of one App cannot be compared:
// the runtime keeps stats per App, not per version.
export function BranchCompare({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation("monitoring");
  const branches = useBranches(org, app);
  const live = (branches.data ?? []).filter((b) => b.live_version !== null);
  const [choice, setChoice] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("24h");
  const branch = live.find((b) => b.slug === choice) ?? live[0];
  if (!branch) return null;
  return (
    <SectionCard
      title={t("compare.title")}
      description={t("compare.description")}
      actions={
        <>
          {live.length > 1 ? (
            <Select value={branch.slug} onValueChange={setChoice}>
              <SelectTrigger aria-label={t("compare.branch")} className="h-7 px-2 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {live.map((b) => (
                  <SelectItem key={b.slug} value={b.slug}>{b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Segmented label={t("range.label")} value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r, label: t(`range.${r}`) }))} />
        </>
      }
    >
      <Figures org={org} app={app} branch={branch.slug} branchName={branch.name} range={range} />
    </SectionCard>
  );
}

function Figures({ org, app, branch, branchName, range }: { org: string; app: string; branch: string; branchName: string; range: Range }) {
  const { t } = useTranslation("monitoring");
  const a = useAppStats(org, app, range);
  const b = useAppStats(org, branch, range);
  if (a.isError || b.isError) return <p className="text-sm text-muted">{t("compare.unavailable")}</p>;
  if (!a.data || !b.data) return <Skeleton className="h-40 w-full" />;
  return <Loaded a={a.data} b={b.data} app={app} branchName={branchName} />;
}

function Loaded({ a, b, app, branchName }: { a: AppStats; b: AppStats; app: string; branchName: string }) {
  const { t } = useTranslation("monitoring");
  const A = { errors: num(a.errors), count: num(a.count) };
  const B = { errors: num(b.errors), count: num(b.count) };
  const enough = A.count >= MIN_COUNT && B.count >= MIN_COUNT;
  const r = compareProportions(A, B);
  const extent = Math.max(Math.abs(r.low), Math.abs(r.high), 0.01) * 1.2;
  const verdict = !enough
    ? t("compare.tooLittle", { min: MIN_COUNT })
    : !r.significant
      ? t("compare.same", { name: branchName })
      : r.difference < 0
        ? t("compare.better", { name: branchName })
        : t("compare.worse", { name: branchName });
  // Only what both sides measured: a missing percentile drawn as 0 would read as a very fast branch.
  const latency = (["p50", "p95", "p99"] as const).flatMap((p) => {
    const before = a[`${p}_ms`];
    const after = b[`${p}_ms`];
    return typeof before === "number" && typeof after === "number" ? [{ key: p, label: p, before, after }] : [];
  });
  const table = [
    { name: app, ...A, rate: r.rateA },
    { name: branchName, ...B, rate: r.rateB },
  ];
  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-3">
        <h3 className="text-sm font-medium">{t("compare.errorRate")}</h3>
        {enough ? (
          <>
            <p className="text-2xl font-light tabular-nums tracking-tight">
              {signedPoints(r.difference)} <span className="text-sm font-normal tracking-normal text-muted">{t("compare.points")}</span>
            </p>
            <p className="text-sm text-muted">{t("compare.interval", { low: signedPoints(r.low), high: signedPoints(r.high) })}</p>
            <IntervalBar estimate={r.difference} low={r.low} high={r.high} extent={extent} />
          </>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 flex-1 text-sm text-muted">{verdict}</p>
          <ExportMenu name={`${app}-compare-${branchName}`} rows={table.map((row) => ({ app: row.name, requests: row.count, errors: row.errors, error_rate: row.rate }))} />
        </div>
        <Table stack>
          <TableHeader>
            <TableRow>
              <TableHead>{t("compare.variant")}</TableHead>
              <TableHead className="text-right">{t("app.requests")}</TableHead>
              <TableHead className="text-right">{t("app.errors")}</TableHead>
              <TableHead className="text-right">{t("app.errorRate")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {table.map((row) => (
              <TableRow key={row.name}>
                <TableCell className="break-all font-medium">{row.name}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(row.count)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(row.errors)}</TableCell>
                <TableCell className="text-right tabular-nums">{pct(row.rate)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <h3 className="text-sm font-medium">{t("compare.latency")}</h3>
        {A.count > 0 && B.count > 0 && latency.length > 0 ? (
          <DumbbellList rows={latency} beforeLabel={app} afterLabel={branchName} format={ms} />
        ) : (
          <p className="text-sm text-muted">{t("analytics.noTraffic")}</p>
        )}
      </div>
    </div>
  );
}
