import { QueryError } from "@/components/features/empty/query-error";
import { Skeleton } from "@/components/ui/skeleton";

import { useOnceSchedules } from "./hooks";

// OnceSchedulesCard lists the one-off tasks the app's code queued with std:schedule
// (after/at). They are read-only here: code creates and cancels them.
export function OnceSchedulesCard({ org, app }: { org: string; app: string }) {
  const once = useOnceSchedules(org, app);

  return (
    <section aria-labelledby="once-schedules-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="once-schedules-heading" className="text-base font-semibold">
          One-off tasks
        </h2>
        <p className="text-sm text-muted">Tasks your code queued with std:schedule, waiting to run.</p>
      </div>
      {once.isError ? (
        <QueryError error={once.error} onRetry={() => void once.refetch()} notFoundTitle="Tasks not found" />
      ) : once.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : once.data.length === 0 ? (
        <p className="text-sm text-muted">No pending tasks.</p>
      ) : (
        <ul className="divide-y divide-line rounded-[6px] border border-line bg-surface">
          {once.data.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <code className="text-xs">{s.id}</code>
              <span className="text-xs text-muted">Runs {new Date(s.run_at).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
