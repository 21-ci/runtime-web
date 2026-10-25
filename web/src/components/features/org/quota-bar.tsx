import { useTranslation } from "react-i18next";

import { QueryError } from "@/components/features/empty/query-error";
import { Progress } from "@/components/ui/progress";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLimits, type Limits, type Quota } from "@/hooks/orgs";
import { formatBytes, formatCount } from "@/lib/format";
import { intlLocale } from "@/lib/i18n";

type Row = {
  key: keyof Omit<Limits, "day" | "resets_at" | "allowed_triggers">;
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

// QuotaBar shows the org's daily and total limits. It is read-only: no plan names, no upgrade
// controls. The block keeps its height while loading so the page does not shift.
export function QuotaBar({ org }: { org: string }) {
  const { t } = useTranslation(["org", "common"]);
  const limits = useLimits(org);
  const title = t("quota.title");

  return (
    <SectionCard
      title={title}
      description={
        limits.data
          ? t("quota.resetsAt", {
              time: new Intl.DateTimeFormat(intlLocale(), { hour: "2-digit", minute: "2-digit" }).format(
                new Date(limits.data.resets_at),
              ),
            })
          : undefined
      }
      aria-label={title}
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
        <ul className="flex flex-col gap-3.5">
          {ROWS.map((row) => (
            <li key={row.key} className="flex flex-col gap-1">
              <QuotaLine row={row} quota={limits.data[row.key]} />
            </li>
          ))}
        </ul>
      ) : null}
    </SectionCard>
  );
}

function QuotaLine({ row, quota }: { row: Row; quota: Quota }) {
  const { t } = useTranslation(["org"]);
  const fmt = row.bytes ? formatBytes : formatCount;
  const pct = quota.limit ? Math.min(100, Math.round((quota.used / quota.limit) * 100)) : 0;
  const high = pct >= 90;
  const label = t(row.labelKey);
  const periodKey = PERIOD_KEY[quota.period];
  const amount =
    quota.limit === null
      ? t("quota.used", { used: fmt(quota.used) })
      : t("quota.amount", {
          used: fmt(quota.used),
          limit: fmt(quota.limit),
          period: periodKey ? t(periodKey) : quota.period,
        });
  return (
    <>
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-sm">
        <span className="shrink-0">{label}</span>
        <span className="min-w-0 truncate text-right tabular-nums text-[12px] text-muted" title={amount}>
          {amount}
        </span>
      </div>
      {quota.limit !== null ? (
        <Progress value={pct} aria-label={t("quota.usage", { label })} className={high ? "[&>div]:bg-danger" : undefined} />
      ) : null}
    </>
  );
}
