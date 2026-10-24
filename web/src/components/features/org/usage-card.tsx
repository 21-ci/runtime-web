import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useUsage } from "@/hooks/orgs";
import { formatBytes, formatCount, formatDuration } from "@/lib/format";

// UsageCard shows today's invocations per app. Rendered only for owners and admins: the caller
// decides, and the query is disabled for everyone else so /usage is never requested by members.
export function UsageCard({ org, enabled }: { org: string; enabled: boolean }) {
  if (!enabled) return null;
  return <UsageCardBody org={org} />;
}

function UsageCardBody({ org }: { org: string }) {
  const usage = useUsage(org, true);
  const rows = usage.data ?? [];
  const total = rows.reduce((sum, r) => sum + r.invocations, 0);
  const cpu = rows.reduce((sum, r) => sum + r.cpu_ms, 0);
  const egress = rows.reduce((sum, r) => sum + r.egress_bytes, 0);

  return (
    <SectionCard title="Usage today" aria-label="Usage">
      {usage.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">No invocations yet today.</p>
      ) : (
        <>
          <dl className="mb-3 grid grid-cols-3 gap-2 text-[12px] text-muted">
            <div>
              <dt>Invocations</dt>
              <dd className="text-[15px] font-semibold tabular-nums text-text">{formatCount(total)}</dd>
            </div>
            <div>
              <dt>CPU</dt>
              <dd className="text-[15px] font-semibold tabular-nums text-text">{formatDuration(cpu)}</dd>
            </div>
            <div>
              <dt>Egress</dt>
              <dd className="text-[15px] font-semibold tabular-nums text-text">{formatBytes(egress)}</dd>
            </div>
          </dl>
          <ul className="flex flex-col divide-y divide-line text-sm">
            {rows.map((r) => (
              <li key={`${r.day}/${r.app ?? "deleted"}`} className="flex justify-between py-1.5">
                <span className="truncate">{r.app ?? "Deleted app"}</span>
                <span className="tabular-nums text-muted">{formatCount(r.invocations)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </SectionCard>
  );
}
