import { Skeleton } from "@/components/ui/skeleton";
import { useUsage } from "@/hooks/orgs";

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

  return (
    <section aria-label="Usage" className="rounded-[10px] border border-line bg-surface p-4">
      <h2 className="mb-3 text-sm font-semibold">Usage today</h2>
      {usage.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">No invocations yet today.</p>
      ) : (
        <>
          <p className="mb-3 text-sm">
            <span className="tabular-nums font-semibold">{total}</span> invocations across {rows.length}{" "}
            {rows.length === 1 ? "app" : "apps"}
          </p>
          <ul className="flex flex-col gap-1 text-sm">
            {rows.map((r) => (
              <li key={`${r.day}/${r.app ?? "deleted"}`} className="flex justify-between">
                <span>{r.app ?? "Deleted app"}</span>
                <span className="tabular-nums text-muted">{r.invocations}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
