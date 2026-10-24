import { QueryError } from "@/components/features/empty/query-error";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useLimits, type Limits, type Quota } from "@/hooks/orgs";

const ROWS: { key: keyof Omit<Limits, "day" | "resets_at">; label: string }[] = [
  { key: "invocations", label: "Invocations" },
  { key: "egress_bytes", label: "Egress" },
  { key: "storage_bytes", label: "Storage" },
  { key: "services", label: "Apps" },
  { key: "schedules", label: "Schedules" },
];

// QuotaBar shows the org's daily and total limits. It is read-only: no plan names, no upgrade
// controls (D3). The block keeps its height while loading so the page does not shift.
export function QuotaBar({ org }: { org: string }) {
  const limits = useLimits(org);

  return (
    <section aria-label="Quota" className="rounded-md border border-line bg-surface p-4">
      <h2 className="mb-3 text-base font-semibold">Quota</h2>
      {limits.isError ? (
        <QueryError
          error={limits.error}
          onRetry={() => void limits.refetch()}
          notFoundTitle="Quota not available"
        />
      ) : limits.isPending ? (
        <div className="flex min-h-[180px] flex-col gap-3" aria-busy="true">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : limits.data ? (
        <ul className="flex flex-col gap-3">
          {ROWS.map(({ key, label }) => (
            <li key={key} className="flex flex-col gap-1">
              <QuotaLine label={label} quota={limits.data[key]} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function QuotaLine({ label, quota }: { label: string; quota: Quota }) {
  const pct = quota.limit ? Math.min(100, Math.round((quota.used / quota.limit) * 100)) : 0;
  return (
    <>
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="tabular-nums text-muted">
          {quota.limit === null ? `${quota.used} used` : `${quota.used} / ${quota.limit} ${quota.period}`}
        </span>
      </div>
      {quota.limit !== null ? <Progress value={pct} aria-label={`${label} usage`} /> : null}
    </>
  );
}
