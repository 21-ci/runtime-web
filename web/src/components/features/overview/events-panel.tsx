import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/features/empty/query-error";

import { useAppEvents } from "./hooks";

// EventsPanel lists the runtime events for the app, newest first, with cursor paging.
export function EventsPanel({ org, app }: { org: string; app: string }) {
  const events = useAppEvents(org, app);

  if (events.isError) {
    return (
      <QueryError
        error={events.error}
        onRetry={() => void events.refetch()}
        notFoundTitle="Events not found"
      />
    );
  }
  if (events.isPending) return <Skeleton className="h-40 w-full" />;

  const items = events.data.pages.flatMap((p) => p.items);
  if (items.length === 0) {
    return <EmptyState title="No events yet" description="Runtime events for this app appear here." />;
  }

  return (
    <section aria-labelledby="events-heading" className="flex flex-col gap-2">
      <h2 id="events-heading" className="text-base font-semibold">
        Events
      </h2>
      <ul className="divide-y divide-line rounded-md border border-line bg-surface">
        {items.map((ev) => (
          <li key={ev.id} className="flex flex-col gap-0.5 px-3 py-2 text-sm sm:flex-row sm:items-center sm:gap-3">
            <span className="font-mono text-xs font-semibold">{ev.kind}</span>
            <time dateTime={new Date(ev.ts).toISOString()} className="text-xs text-muted">
              {new Date(ev.ts).toLocaleString()}
            </time>
            <span className="truncate text-xs text-muted">{JSON.stringify(ev.data)}</span>
          </li>
        ))}
      </ul>
      {events.hasNextPage ? (
        <Button
          variant="secondary"
          className="self-start"
          disabled={events.isFetchingNextPage}
          onClick={() => void events.fetchNextPage()}
        >
          {events.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </section>
  );
}
