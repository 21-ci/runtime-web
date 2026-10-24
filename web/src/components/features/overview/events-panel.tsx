import { AlertTriangle, CheckCircle2, Circle, Hammer, Rocket, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/features/empty/query-error";
import { formatDateTime, formatQuantity, formatRelative, labelFor } from "@/lib/format";
import { cn } from "@/lib/utils";

import { useAppEvents, type AppEvent } from "./hooks";

// eventStyle picks an icon and colour from the event kind: *.failed and *.error are red,
// version.live and *.ready green, build.* yellow, everything else neutral.
function eventStyle(kind: string): { Icon: LucideIcon; className: string } {
  if (/fail|error|dead/.test(kind)) return { Icon: AlertTriangle, className: "bg-tag-red-bg text-tag-red-text" };
  if (/live|ready|ok|success/.test(kind)) return { Icon: CheckCircle2, className: "bg-tag-green-bg text-tag-green-text" };
  if (/build/.test(kind)) return { Icon: Hammer, className: "bg-tag-yellow-bg text-tag-yellow-text" };
  if (/deploy|version|promote/.test(kind)) return { Icon: Rocket, className: "bg-tag-blue-bg text-tag-blue-text" };
  return { Icon: Circle, className: "bg-tag-gray-bg text-tag-gray-text" };
}

// eventFields flattens the event payload into readable label/value pairs (one level deep).
export function eventFields(data: unknown, prefix = ""): { label: string; value: string }[] {
  if (data === null || data === undefined) return [];
  if (typeof data !== "object") return [{ label: prefix || "Value", value: String(data) }];
  if (Array.isArray(data)) return [{ label: prefix || "Items", value: data.length === 0 ? "none" : JSON.stringify(data) }];
  return Object.entries(data as Record<string, unknown>).flatMap(([k, v]) => {
    const label = prefix ? `${prefix} ${k.replace(/[_-]+/g, " ")}` : labelFor(k);
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return eventFields(v, label);
    return [{ label, value: v !== null && typeof v === "object" ? JSON.stringify(v) : formatQuantity(k, v) }];
  });
}

function EventRow({ ev, last }: { ev: AppEvent; last: boolean }) {
  const { Icon, className } = eventStyle(ev.kind);
  const fields = eventFields(ev.data);
  return (
    <li className="relative flex gap-3 px-5 py-3">
      {!last ? <span aria-hidden="true" className="absolute left-[31px] top-10 bottom-0 w-px bg-line" /> : null}
      <span className={cn("grid size-6 shrink-0 place-items-center rounded-md", className)} aria-hidden="true">
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-[13px] font-medium">{ev.kind}</span>
          <time dateTime={new Date(ev.ts).toISOString()} title={formatDateTime(ev.ts)} className="text-[12px] text-muted">
            {formatRelative(ev.ts)}
          </time>
        </div>
        {fields.length > 0 ? (
          <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px]">
            {fields.map((f) => (
              <div key={f.label} className="flex min-w-0 gap-1">
                <dt className="text-muted">{f.label}</dt>
                <dd className="truncate font-mono text-text">{f.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </li>
  );
}

// EventsPanel lists the runtime events for the app, newest first, with cursor paging.
export function EventsPanel({ org, app }: { org: string; app: string }) {
  const events = useAppEvents(org, app);

  if (events.isError) {
    return <QueryError error={events.error} onRetry={() => void events.refetch()} notFoundTitle="Events not found" />;
  }
  if (events.isPending) return <Skeleton className="h-40 w-full" />;

  const items = events.data.pages.flatMap((p) => p.items);

  return (
    <SectionCard title="Events" description="What the runtime did with this app, newest first." flush>
      {items.length === 0 ? (
        <EmptyState bare entity="overview" title="No events yet" description="Runtime events for this app appear here." />
      ) : (
        <ol>
          {items.map((ev, i) => (
            <EventRow key={ev.id} ev={ev} last={i === items.length - 1} />
          ))}
        </ol>
      )}
      {events.hasNextPage ? (
        <div className="border-t border-line px-5 py-3">
          <Button variant="secondary" size="sm" disabled={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>
            {events.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </SectionCard>
  );
}
