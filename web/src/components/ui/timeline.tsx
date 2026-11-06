import { ChevronRight, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { formatDateTime, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

import { IconTile, type Hue } from "./icon-tile";

export interface TimelineItem {
  id: string;
  icon: LucideIcon;
  hue?: Hue;
  /** Plain-language sentence: "Rolled back v3 to v2". */
  title: ReactNode;
  actor?: ReactNode;
  /** Epoch milliseconds. */
  at: number;
  /** Structured detail as label and value rows. Never a raw JSON blob. */
  rows?: { label: string; value: ReactNode }[];
  /** Any other detail (steps with durations), shown after the rows. */
  detail?: ReactNode;
}

function Row({ item, now }: { item: TimelineItem; now: number | undefined }) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(item.rows?.length) || item.detail != null;
  const head = (
    <>
      <span className="min-w-0 flex-1 text-sm text-text">
        {item.title}
        {item.actor != null ? <span className="ms-2 text-[13px] text-muted">{item.actor}</span> : null}
      </span>
      <time dateTime={new Date(item.at).toISOString()} title={formatDateTime(item.at)} className="shrink-0 text-[12px] tabular-nums text-muted">
        {formatRelative(item.at, now)}
      </time>
    </>
  );
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      <span aria-hidden="true" className="absolute start-3 top-7 bottom-0 w-px -translate-x-1/2 bg-line rtl:translate-x-1/2 [li:last-child>&]:hidden" />
      <IconTile icon={item.icon} hue={item.hue ?? "gray"} size="sm" />
      <div className="min-w-0 flex-1">
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex min-h-6 w-full cursor-pointer items-start gap-2 rounded-sm text-start outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <ChevronRight aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0 text-muted transition-transform", open && "rotate-90")} />
            {head}
          </button>
        ) : (
          <div className="flex min-h-6 items-start gap-2">{head}</div>
        )}
        {open ? (
          <div className="mt-2 flex flex-col gap-2 ps-6 text-[13px]">
            {item.rows?.length ? (
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
                {item.rows.map((r) => (
                  <div key={r.label} className="contents">
                    <dt className="text-muted">{r.label}</dt>
                    <dd className="min-w-0 break-words text-text">{r.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {item.detail}
          </div>
        ) : null}
      </div>
    </li>
  );
}

// Timeline is the one history view (guidelines rule 9): versions, switches, events, audit, alerts, backups. The caller
// bounds it (BoundedList or a slice) and maps its records to items.
export function Timeline({ items, now, className }: { items: readonly TimelineItem[]; now?: number; className?: string }) {
  return (
    <ul className={cn("flex flex-col", className)}>
      {items.map((item) => (
        <Row key={item.id} item={item} now={now} />
      ))}
    </ul>
  );
}
