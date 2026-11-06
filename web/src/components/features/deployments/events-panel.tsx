import { AlertTriangle, CheckCircle2, Circle, Hammer, Rocket, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ExportMenu } from "@/components/ui/export-menu";
import type { Hue } from "@/components/ui/icon-tile";
import { SectionCard } from "@/components/ui/section-card";
import { Timeline, type TimelineItem } from "@/components/ui/timeline";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/features/empty/query-error";
import { i18n } from "@/lib/i18n";
import { formatDateTime, formatQuantity, formatRelative, labelFor } from "@/lib/format";

import { eventNote, eventTitle, groupEvents, groupTitle, type EventGroup } from "./event-text";
import { useAppEvents, type AppEvent } from "@/components/features/overview/hooks";

// eventStyle picks an icon and colour from the event kind: *.failed and *.error are red,
// version.live and *.ready green, build.* yellow, everything else neutral.
function eventStyle(kind: string): { icon: LucideIcon; hue: Hue } {
  if (/fail|error|dead/.test(kind)) return { icon: AlertTriangle, hue: "red" };
  if (/live|ready|ok|success/.test(kind)) return { icon: CheckCircle2, hue: "green" };
  if (/build/.test(kind)) return { icon: Hammer, hue: "yellow" };
  if (/deploy|version|promote/.test(kind)) return { icon: Rocket, hue: "blue" };
  return { icon: Circle, hue: "gray" };
}

// eventFields flattens the event payload into readable label/value pairs (one level deep).
export function eventFields(data: unknown, prefix = ""): { label: string; value: string }[] {
  if (data === null || data === undefined) return [];
  if (typeof data !== "object") return [{ label: prefix || i18n.t("overview:events.value"), value: String(data) }];
  if (Array.isArray(data))
    return [
      {
        label: prefix || i18n.t("overview:events.items"),
        value: data.length === 0 ? i18n.t("overview:events.none") : JSON.stringify(data),
      },
    ];
  return Object.entries(data as Record<string, unknown>).flatMap(([k, v]) => {
    const label = prefix ? `${prefix} ${k.replace(/[_-]+/g, " ")}` : labelFor(k);
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return eventFields(v, label);
    return [{ label, value: v !== null && typeof v === "object" ? JSON.stringify(v) : formatQuantity(k, v) }];
  });
}

// EventDetails: the event's IDs and payload, which nothing else on the page shows, as labelled rows.
export function EventDetails({ value }: { value: unknown }) {
  const { t } = useTranslation("operator");
  return (
    <details className="mt-1 min-w-0 text-[12px] text-muted">
      <summary className="cursor-pointer select-none">{t("details")}</summary>
      <dl className="mt-1 grid max-h-72 grid-cols-[fit-content(45%)_minmax(0,1fr)] gap-x-4 gap-y-1 overflow-auto rounded bg-surface-2 p-2">
        {eventFields(value).map((f) => (
          <div key={f.label} className="contents">
            <dt className="min-w-0 break-words">{f.label}</dt>
            <dd className="min-w-0 break-all text-text">{f.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function WhenStep({ ts }: { ts: number }) {
  return (
    <time dateTime={new Date(ts).toISOString()} title={formatDateTime(ts)} className="text-[12px] text-muted">
      {formatRelative(ts)}
    </time>
  );
}

// One group as a timeline row: a plain title, and the steps of a switch or the event's fields when opened.
function toItem(group: EventGroup<AppEvent>): TimelineItem {
  const head = group.events[group.events.length - 1] as AppEvent;
  const { icon, hue } = eventStyle(group.change?.failed ? "failed" : group.change ? "version.live" : head.kind);
  const note = group.change ? null : eventNote(head);
  return {
    id: group.key,
    icon,
    hue,
    at: group.ts,
    title: (
      <>
        {groupTitle(group)}
        {note ? <span className="block break-words text-[12px] text-muted">{note}</span> : null}
      </>
    ),
    ...(group.change
      ? {
          detail: (
            <ol className="flex flex-col gap-1">
              {group.events.map((e) => (
                <li key={e.id} className="flex flex-col">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-text">{eventTitle(e.kind)}</span>
                    <WhenStep ts={e.ts} />
                  </span>
                  <EventDetails value={e} />
                </li>
              ))}
            </ol>
          ),
        }
      : { rows: eventFields(head) }),
  };
}

// EventsPanel lists the runtime events for the app, newest first, with cursor paging. hideSwitches is for the
// Deployments page, whose table already has a row for every switch.
export function EventsPanel({ org, app, hideSwitches = false }: { org: string; app: string; hideSwitches?: boolean }) {
  const { t } = useTranslation("overview");
  const events = useAppEvents(org, app);

  if (events.isError) {
    return <QueryError error={events.error} onRetry={() => void events.refetch()} notFoundTitle={t("events.notFound")} />;
  }
  if (events.isPending) return <Skeleton className="h-40 w-full" />;

  const items = groupEvents(events.data.pages.flatMap((p) => p.items)).filter((g) => !hideSwitches || !g.change);

  return (
    <SectionCard
      title={t("events.title")}
      description={t("events.description")}
      flush
      bounded
      actions={<ExportMenu name={`${app}-events`} rows={events.data.pages.flatMap((p) => p.items) as unknown as Record<string, unknown>[]} />}
    >
      {items.length === 0 ? (
        <EmptyState bare entity="overview" title={t("events.emptyTitle")} description={t("events.emptyDescription")} />
      ) : (
        <Timeline items={items.map(toItem)} className="px-5 py-3" />
      )}
      {events.hasNextPage ? (
        <div className="border-t border-line px-5 py-3">
          <Button variant="secondary" size="sm" disabled={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>
            {events.isFetchingNextPage ? t("events.loading") : t("events.loadMore")}
          </Button>
        </div>
      ) : null}
    </SectionCard>
  );
}
