import { QueryError } from "@/components/features/empty/query-error";
import { Progress } from "@/components/ui/progress";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLimits, type Limits, type Quota } from "@/hooks/orgs";
import { formatBytes, formatCount } from "@/lib/format";

type Row = { key: keyof Omit<Limits, "day" | "resets_at" | "allowed_triggers">; label: string; bytes?: boolean };

const ROWS: Row[] = [
  { key: "invocations", label: "Invocations" },
  { key: "egress_bytes", label: "Egress", bytes: true },
  { key: "storage_bytes", label: "Storage", bytes: true },
  { key: "services", label: "Apps" },
  { key: "schedules", label: "Schedules" },
];

const PERIOD: Record<string, string> = { day: "per day", total: "total", month: "per month", per_service: "per app" };

// QuotaBar shows the org's daily and total limits. It is read-only: no plan names, no upgrade
// controls. The block keeps its height while loading so the page does not shift.
export function QuotaBar({ org }: { org: string }) {
  const limits = useLimits(org);

  return (
    <SectionCard
      title="Quota"
      description={limits.data ? `Daily counters reset ${new Date(limits.data.resets_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : undefined}
      aria-label="Quota"
    >
      {limits.isError ? (
        <QueryError error={limits.error} onRetry={() => void limits.refetch()} notFoundTitle="Quota not available" />
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
  const fmt = row.bytes ? formatBytes : formatCount;
  const pct = quota.limit ? Math.min(100, Math.round((quota.used / quota.limit) * 100)) : 0;
  const high = pct >= 90;
  return (
    <>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span>{row.label}</span>
        <span className="tabular-nums text-[12px] text-muted">
          {quota.limit === null ? `${fmt(quota.used)} used` : `${fmt(quota.used)} / ${fmt(quota.limit)} ${PERIOD[quota.period] ?? quota.period}`}
        </span>
      </div>
      {quota.limit !== null ? (
        <Progress value={pct} aria-label={`${row.label} usage`} className={high ? "[&>div]:bg-danger" : undefined} />
      ) : null}
    </>
  );
}
