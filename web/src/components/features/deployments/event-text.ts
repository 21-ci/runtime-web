import { i18n } from "@/lib/i18n";

// Runtime events in words. Only what a reader can act on makes the row; everything else stays in the row's details.

export type EventLike = { id: string | number; ts: number; kind: string; data?: unknown; service?: string | null };

export type EventGroup<E extends EventLike = EventLike> = {
  key: string;
  ts: number;
  events: E[];
  /** Set when these events are the steps of one version switch. */
  change?: { from: number | null; to: number; failed: boolean };
};

const CHANGE_WINDOW_MS = 5 * 60_000;
const SWITCH_SIBLINGS = new Set(["service.promoted", "service.promote_failed", "service.migrated", "service.migration_failed"]);

const dataOf = (e: EventLike): Record<string, unknown> => (e.data && typeof e.data === "object" ? (e.data as Record<string, unknown>) : {});
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** The event's name in the UI language; a kind this console does not know reads as its own words. */
export function eventTitle(kind: string): string {
  const words = kind.replace(/[._]+/g, " ").trim();
  return i18n.t(`operator:events.kinds.${kind.replace(/\./g, "_")}`, { defaultValue: words.charAt(0).toUpperCase() + words.slice(1) });
}

/** One short fact about the event, or nothing. IDs and digests never make it here. */
export function eventNote(e: EventLike): string | null {
  const d = dataOf(e);
  if (typeof d.error === "string" && d.error) return d.error;
  const parts: string[] = [];
  const from = num(d.from);
  const to = num(d.to) ?? num(d.version);
  if (from !== null && to !== null) parts.push(i18n.t("operator:events.versionMove", { from, to }));
  else if (to !== null) parts.push(i18n.t("operator:events.version", { version: to }));
  const closed = num(d.sockets_closed);
  if (closed) parts.push(i18n.t("operator:events.socketsClosed", { count: closed }));
  return parts.length ? parts.join(", ") : null;
}

/**
 * Folds the several events of one version switch into one group, keeping the list's order. Events of a switch carry its
 * ID; the promote and migrate events that go with it are matched by service, target version and time.
 */
export function groupEvents<E extends EventLike>(items: readonly E[]): EventGroup<E>[] {
  const groups: EventGroup<E>[] = [];
  const bySwitch = new Map<string, EventGroup<E>>();
  const stray: E[] = [];
  const order = new Map<E, number>();
  items.forEach((e, i) => order.set(e, i));
  const first = new Map<EventGroup<E>, number>();

  for (const e of items) {
    const d = dataOf(e);
    const id = typeof d.switch === "string" ? d.switch : null;
    if (!id) {
      stray.push(e);
      continue;
    }
    const key = `switch:${e.service ?? ""}:${id}`;
    let g = bySwitch.get(key);
    if (!g) {
      g = { key, ts: e.ts, events: [], change: { from: null, to: 0, failed: false } };
      bySwitch.set(key, g);
      groups.push(g);
      first.set(g, order.get(e) ?? 0);
    }
    g.events.push(e);
    g.ts = Math.max(g.ts, e.ts);
    const change = g.change;
    if (change) {
      change.from = change.from ?? num(d.from);
      change.to = num(d.to) ?? num(d.version) ?? change.to;
      change.failed = change.failed || /fail/.test(e.kind);
    }
  }

  for (const e of stray) {
    const d = dataOf(e);
    const to = num(d.to) ?? num(d.version);
    const home = SWITCH_SIBLINGS.has(e.kind)
      ? groups.find((g) => g.change?.to === to && g.events[0]?.service === e.service && Math.abs(g.ts - e.ts) <= CHANGE_WINDOW_MS)
      : undefined;
    if (home?.change) {
      home.events.push(e);
      home.change.failed = home.change.failed || /fail/.test(e.kind);
      continue;
    }
    const g: EventGroup<E> = { key: String(e.id), ts: e.ts, events: [e] };
    groups.push(g);
    first.set(g, order.get(e) ?? 0);
  }

  for (const g of groups) g.events.sort((a, b) => a.ts - b.ts);
  return groups.sort((a, b) => (first.get(a) ?? 0) - (first.get(b) ?? 0));
}

/** The one line a group shows when closed. */
export function groupTitle(g: EventGroup): string {
  const c = g.change;
  if (!c) return eventTitle(g.events[0]?.kind ?? "");
  if (c.failed) return i18n.t("operator:events.switchFailed", { to: c.to });
  return c.from !== null ? i18n.t("operator:events.switchFromTo", { from: c.from, to: c.to }) : i18n.t("operator:events.switchTo", { to: c.to });
}
