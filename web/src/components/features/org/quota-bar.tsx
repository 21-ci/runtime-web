import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { QueryError } from "@/components/features/empty/query-error";
import { Badge } from "@/components/ui/badge";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLimits, type Limits, type Quota } from "@/hooks/orgs";
import { formatBytes, formatCount } from "@/lib/format";
import { intlLocale } from "@/lib/i18n";

import { NEAR_PCT, UsageRows, type UsageRow } from "./usage-rows";

type Row = {
  key: keyof Omit<Limits, "day" | "resets_at" | "allowed_triggers" | "hidden_services">;
  labelKey: "quota.rows.invocations" | "quota.rows.egress" | "quota.rows.storage" | "quota.rows.apps" | "quota.rows.schedules";
  bytes?: boolean;
};

const ROWS: Row[] = [
  { key: "invocations", labelKey: "quota.rows.invocations" },
  { key: "egress_bytes", labelKey: "quota.rows.egress", bytes: true },
  { key: "storage_bytes", labelKey: "quota.rows.storage", bytes: true },
  { key: "services", labelKey: "quota.rows.apps" },
  { key: "schedules", labelKey: "quota.rows.schedules" },
];

const PERIOD_KEY: Record<string, "quota.period.day" | "quota.period.total" | "quota.period.month" | "quota.period.perService"> = {
  day: "quota.period.day",
  total: "quota.period.total",
  month: "quota.period.month",
  per_service: "quota.period.perService",
};

const usedPct = (q: Quota) => (q.limit ? Math.min(100, Math.round((q.used / q.limit) * 100)) : 0);

// QuotaBar shows the org's daily and total limits. It is read-only: no plan names, no upgrade
// controls. The block keeps its height while loading so the page does not shift.
export function QuotaBar({ org }: { org: string }) {
  const { t } = useTranslation(["org", "common", "operator"]);
  const limits = useLimits(org);
  const title = t("quota.title");
  const data = limits.data;
  const near = data ? ROWS.filter((row) => usedPct(data[row.key]) >= NEAR_PCT).length : 0;

  return (
    <SectionCard
      title={title}
      description={
        limits.data
          ? t("quota.resetsAt", {
              time: new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium", timeStyle: "short" }).format(
                new Date(limits.data.resets_at),
              ),
            })
          : undefined
      }
      aria-label={title}
      actions={
        data ? (
          <Badge variant={near ? "warning" : "success"} dot>
            {near ? t("quota.near", { count: near }) : t("quota.ok")}
          </Badge>
        ) : undefined
      }
    >
      {limits.isError ? (
        <QueryError error={limits.error} onRetry={() => void limits.refetch()} notFoundTitle={t("quota.unavailable")} />
      ) : limits.isPending ? (
        <div className="flex min-h-[180px] flex-col gap-3" aria-busy="true">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : limits.data ? (
        <UsageRows
          rows={ROWS.map((row) => quotaRow(row, limits.data[row.key], limits.data.hidden_services ?? 0, t))}
          ariaLabel={(label) => t("quota.usage", { label })}
        />
      ) : null}
    </SectionCard>
  );
}

function quotaRow(row: Row, quota: Quota, hidden: number, t: TFunction<["org", "common", "operator"]>): UsageRow {
  // The runtime's storage counter stays at 0 whatever the disk holds, so 0 here says nothing.
  const unmetered = row.key === "storage_bytes" && quota.used === 0;
  const fmt = row.bytes ? formatBytes : formatCount;
  const label = t(row.labelKey);
  const periodKey = PERIOD_KEY[quota.period];
  const amount = unmetered
    ? quota.limit === null
      ? t("operator:plan.notMetered")
      : t("operator:plan.notMeteredLimit", { limit: fmt(quota.limit) })
    : quota.limit === null
      ? t("quota.used", { used: fmt(quota.used) })
      : t("quota.amount", {
          used: fmt(quota.used),
          limit: fmt(quota.limit),
          period: periodKey ? t(periodKey) : quota.period,
        });
  const note = unmetered ? t("operator:plan.storageHint") : row.key === "services" && hidden > 0 ? t("operator:plan.includingHidden", { count: hidden }) : null;
  const bar = quota.limit !== null && !unmetered;
  return { key: row.key, label, amount, note, used: bar ? quota.used : null, limit: bar ? quota.limit : null };
}
