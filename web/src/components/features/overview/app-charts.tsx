import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { appPath } from "@/components/features/app-header/hooks";
import { RangeSwitch } from "@/components/features/admin/range-switch";
import { pollInterval } from "@/components/features/admin/use-monitoring";
import { LineChart } from "@/components/ui/line-chart";
import { SectionCard } from "@/components/ui/section-card";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

type Range = "1h" | "24h" | "7d";
const RANGES: readonly Range[] = ["1h", "24h", "7d"];
const QUERY: Record<Range, string> = { "1h": "window=1h&step=1m", "24h": "window=24h&step=5m", "7d": "window=7d" };

type Point = { ts: number; count?: number; errors?: number; total_p95?: number | null };
type Series = { series?: Point[]; data_from?: number | null };

// AppCharts: this App's traffic. Org members reach it through the App's own stats route, under the org's tenant
// key, so nothing here can name another tenant's service.
export function AppCharts({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation("monitoring");
  const [range, setRange] = useState<Range>("1h");
  const q = useQuery({
    queryKey: ["app-series", org, app, range],
    queryFn: () => api.get<Series>(`${appPath(org, app)}/stats?${QUERY[range]}`),
    refetchInterval: pollInterval,
    retry: false,
  });
  if (q.isError) return null;
  const points = q.data?.series ?? [];
  const labels = { noData: t("chart.noData"), table: t("chart.table"), time: t("chart.time"), value: t("chart.value") };
  const line = (pick: (p: Point) => number | null | undefined) => points.map((p) => ({ ts: p.ts, value: pick(p) ?? null }));
  return (
    <SectionCard title={t("app.title")} actions={<RangeSwitch ranges={RANGES} value={range} onChange={setRange} />}>
      <div className="grid min-w-0 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <LineChart title={t("app.requests")} labels={labels} points={line((p) => p.count)} />
        <LineChart title={t("app.errors")} labels={labels} points={line((p) => p.errors)} />
        {range !== "7d" ? <LineChart title={t("app.p95")} labels={labels} points={line((p) => p.total_p95)} /> : null}
      </div>
      {range === "7d" ? (
        <p className="mt-3 text-xs text-muted">
          {t("app.weekNote")} {q.data?.data_from ? t("chart.dataFrom", { time: formatDateTime(q.data.data_from) }) : ""}
        </p>
      ) : null}
    </SectionCard>
  );
}
