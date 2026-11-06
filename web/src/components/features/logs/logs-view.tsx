import { ChevronRight, Cog, Hammer, Pause, Play, RefreshCw, RotateCw, Terminal, Trash2, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ExportMenu } from "@/components/ui/export-menu";
import { Input } from "@/components/ui/input";
import { NoData } from "@/components/ui/no-data";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";
import { intlLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import { exportQuery, matchesLine, parseFilterText, rangeBounds, type LogKind, type LogMode, type LogSearch, type RangeKey } from "./log-filter";
import { useLogRange } from "./use-log-range";
import { type ConnState, type LogLevel, type LogLine, useLogStream } from "./use-log-stream";

// ALL stands in for "no filter"; Radix Select items cannot have an empty value.
const ALL = "all";

const CONN_KEY = {
  connecting: "conn.connecting",
  connected: "conn.connected",
  reconnecting: "conn.reconnecting",
  closed: "conn.closed",
} as const satisfies Record<ConnState, string>;

const LEVEL_OPTIONS = [
  { value: ALL, labelKey: "levels.all" },
  { value: "debug", labelKey: "levels.debug" },
  { value: "info", labelKey: "levels.info" },
  { value: "warn", labelKey: "levels.warn" },
  { value: "error", labelKey: "levels.error" },
] as const;

const LEVEL_VARIANT: Record<string, "danger" | "warning" | "info" | "outline"> = {
  error: "danger",
  warn: "warning",
  info: "info",
  debug: "outline",
};

const KIND_ICON: Record<LogKind, LucideIcon> = { runtime: Terminal, build: Hammer, system: Cog };

// LogsView shows one app's logs: the live tail, or a past range read from the server. Pause holds new lines in a
// buffer, the level select is a server-side minimum, kind and text narrow what is shown. `compact` is the dock inside
// the code page: live only, no heading, full height, smaller controls. `search` comes from the URL on the page.
export function LogsView({
  org,
  app,
  compact = false,
  search,
  onSearchChange,
}: {
  org: string;
  app: string;
  compact?: boolean;
  search?: LogSearch;
  onSearchChange?: (next: LogSearch) => void;
}) {
  const { t } = useTranslation("logs");
  const [own, setOwn] = useState<LogSearch>({});
  const s = search ?? own;
  const set = onSearchChange ?? setOwn;
  const patch = (p: LogSearch) => {
    const next: Record<string, unknown> = { ...s, ...p };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === "") delete next[k];
    set(next as LogSearch);
  };

  const mode: LogMode = compact ? "live" : (s.mode ?? "live");
  const level: LogLevel = s.level ?? "";
  // A preset ends when it was chosen, so the window holds still until the user asks for a new one.
  const [anchor, setAnchor] = useState(() => Date.now());
  const bounds = useMemo(() => (mode === "range" ? rangeBounds(s, anchor) : null), [mode, s.range, s.since, s.until, anchor]); // eslint-disable-line react-hooks/exhaustive-deps -- s is rebuilt each navigation

  const parsed = useMemo(() => parseFilterText(s.q ?? ""), [s.q]);
  const filter = { ...parsed, ...(parsed.kind || !s.kind ? {} : { kind: s.kind }) };
  const serverFilter = { ...(filter.level ?? s.level ? { level: (filter.level ?? s.level) as NonNullable<LogSearch["level"]> } : {}), ...(filter.kind ? { kind: filter.kind } : {}) };

  const stream = useLogStream(org, app, level, mode === "live");
  const range = useLogRange(org, app, serverFilter, bounds);

  const rangeLines = useMemo(() => {
    const seen = new Set<number>();
    return (range.data?.pages ?? []).flatMap((p) => p.lines).filter((l) => !seen.has(l.seq) && Boolean(seen.add(l.seq)));
  }, [range.data]);
  const lines = mode === "live" ? stream.lines : rangeLines;
  const visible = useMemo(() => lines.filter((l) => matchesLine(l, filter)), [lines, filter.level, filter.kind, filter.text]); // eslint-disable-line react-hooks/exhaustive-deps -- the fields are the identity

  const size = compact ? "sm" : "default";
  const control = cn("w-auto shadow-none", compact ? "h-7 text-[13px]" : "h-8");
  const exportBase = `/api/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}/logs`;
  const rangeKey: RangeKey = s.range ?? "1h";

  return (
    <section className={cn("flex min-h-0 flex-col", compact ? "h-full" : "flex-1 gap-3")} aria-labelledby={compact ? undefined : "logs-heading"} aria-label={compact ? t("compactLabel") : undefined}>
      <div className={cn("flex flex-wrap items-center gap-2", compact ? "border-b border-line px-2 py-1.5" : "")}>
        {!compact ? (
          <>
            <h2 id="logs-heading" className="me-auto text-[15px] font-semibold">
              {t("title")}
            </h2>
            <Segmented
              label={t("modeLabel")}
              value={mode}
              onChange={(m) => {
                setAnchor(Date.now());
                patch({ mode: m === "live" ? undefined : m } as LogSearch);
              }}
              options={[
                { value: "live", label: t("mode.live") },
                { value: "range", label: t("mode.range") },
              ]}
            />
          </>
        ) : null}
        <Input
          aria-label={t("filterLabel")}
          placeholder={t("filterPlaceholder")}
          value={s.q ?? ""}
          onChange={(e) => patch({ q: e.target.value })}
          className={cn("w-56 shadow-none", compact ? "h-7 text-[13px]" : "h-8")}
        />
        <Select value={level || ALL} onValueChange={(v) => patch({ level: v === ALL ? undefined : v } as LogSearch)}>
          <SelectTrigger aria-label={t("levelLabel")} className={cn(control, "min-w-36")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEVEL_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {t(o.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!compact ? (
          <Select value={s.kind ?? ALL} onValueChange={(v) => patch({ kind: v === ALL ? undefined : v } as LogSearch)}>
            <SelectTrigger aria-label={t("kindLabel")} className={cn(control, "min-w-28")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("kinds.all")}</SelectItem>
              {(["runtime", "build", "system"] as const).map((k) => (
                <SelectItem key={k} value={k}>
                  {t(`kinds.${k}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <span className={cn("flex flex-wrap items-center gap-2", compact ? "ms-auto" : "")}>
          {mode === "live" ? (
            <>
              <Badge variant={stream.conn === "connected" ? "success" : "outline"} dot={stream.conn === "connected"} aria-live="polite">
                {t(CONN_KEY[stream.conn])}
              </Badge>
              {stream.conn === "closed" ? (
                <Button variant="secondary" size={size} onClick={stream.reconnect}>
                  <RotateCw aria-hidden="true" />
                  {t("reconnect")}
                </Button>
              ) : null}
              {stream.paused && stream.buffered > 0 ? <span className="text-[12px] text-muted">{t("buffered", { count: stream.buffered })}</span> : null}
              <Button variant="ghost" size={size} onClick={() => stream.setPaused(!stream.paused)}>
                {stream.paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                {stream.paused ? t("resume") : t("pause")}
              </Button>
            </>
          ) : null}
          <ExportMenu formats={["ndjson", "txt"] as const} size={size} disabled={mode === "range" && bounds === null} href={(f) => `${exportBase}?${exportQuery(f, serverFilter, bounds)}`} />
          {mode === "live" ? (
            <Button variant="ghost" size={size} onClick={stream.clear}>
              <Trash2 aria-hidden="true" />
              {t("clear")}
            </Button>
          ) : null}
        </span>
      </div>

      {mode === "range" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label={t("rangeLabel")}
            value={rangeKey}
            onChange={(r) => {
              setAnchor(Date.now());
              patch({ range: r });
            }}
            options={[
              { value: "15m", label: "15 min" },
              { value: "1h", label: "1 h" },
              { value: "24h", label: "24 h" },
              { value: "custom", label: t("range.custom") },
            ]}
          />
          {rangeKey === "custom" ? (
            <>
              <DateTime label={t("range.since")} value={s.since} onChange={(v) => patch({ since: v })} />
              <DateTime label={t("range.until")} value={s.until} onChange={(v) => patch({ until: v })} />
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setAnchor(Date.now())}>
              <RefreshCw aria-hidden="true" />
              {t("refresh")}
            </Button>
          )}
        </div>
      ) : null}

      {!compact ? <p className="text-[13px] text-muted">{t("scope")}</p> : null}

      {mode === "live" && stream.gap ? (
        <p role="status" className="px-2 text-[12px] text-muted">
          <span>{t("gap")}</span>
        </p>
      ) : null}
      {mode === "live" && stream.terminal ? (
        <p role="alert" className="px-2 text-[13px] text-danger-text">
          <span>{stream.terminal}</span>
        </p>
      ) : null}

      {mode === "range" && bounds === null ? (
        <p className="text-[13px] text-muted">{t("range.invalid")}</p>
      ) : mode === "range" && range.isError ? (
        <EmptyState variant="error" title={t("rangeError")} details={range.error.message} onRetry={() => void range.refetch()} />
      ) : mode === "range" && range.isPending ? (
        <div aria-hidden="true" className="flex flex-col gap-2 rounded-lg border border-line p-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        compact ? (
          <p className="px-3 py-4 text-[13px] text-muted">{lines.length === 0 ? t("empty.compact") : t("empty.compactNoMatch")}</p>
        ) : mode === "range" && bounds && lines.length === 0 ? (
          <EmptyState variant="no-range" title={t("noRange", { since: formatDateTime(bounds.since), until: formatDateTime(bounds.until) })} />
        ) : (
          <EmptyState
            entity="logs"
            title={lines.length === 0 ? t("empty.title") : t("empty.noMatchTitle")}
            description={lines.length === 0 ? t("empty.description") : t("empty.noMatchDescription")}
          />
        )
      ) : (
        <ol
          aria-label={t("linesLabel")}
          className={cn(
            "min-h-0 flex-1 overflow-auto bg-canvas-inset font-mono text-[12px] leading-[1.7]",
            compact ? "px-2 py-1" : "max-h-[calc(100dvh-260px)] rounded-lg border border-line p-2",
          )}
        >
          {visible.map((l) => (
            <LogRow key={l.seq} line={l} />
          ))}
          {mode === "range" && range.hasNextPage ? (
            <li className="flex justify-center py-2 font-sans">
              <Button variant="ghost" size="sm" disabled={range.isFetchingNextPage} onClick={() => void range.fetchNextPage()}>
                {t("loadNewer")}
              </Button>
            </li>
          ) : null}
        </ol>
      )}
    </section>
  );
}

// A datetime-local works in the viewer's zone; the search holds the same instant in UTC.
function DateTime({ label, value, onChange }: { label: string; value: string | undefined; onChange: (iso: string | undefined) => void }) {
  const local = value && !Number.isNaN(Date.parse(value)) ? new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "";
  return (
    <label className="flex items-center gap-1.5 text-[13px] text-muted">
      {label}
      <Input
        type="datetime-local"
        value={local}
        onChange={(e) => {
          const ms = Date.parse(e.target.value);
          onChange(Number.isNaN(ms) ? undefined : new Date(ms).toISOString());
        }}
        className="h-8 w-auto shadow-none"
      />
    </label>
  );
}

// Long lists stay cheap with content-visibility: rows off screen are not laid out or painted.
function LogRow({ line }: { line: LogLine }) {
  const { t } = useTranslation("logs");
  const [open, setOpen] = useState(false);
  const KindIcon = KIND_ICON[line.kind] ?? Terminal;
  return (
    <li className="[contain-intrinsic-size:auto_20px] [content-visibility:auto]">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full cursor-pointer items-start gap-2 px-1 text-start outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus">
        <ChevronRight aria-hidden="true" className={cn("mt-1 size-3 shrink-0 text-muted transition-transform", open && "rotate-90")} />
        <time className="shrink-0 tabular-nums text-muted" dateTime={new Date(line.ts).toISOString()} title={formatDateTime(line.ts)}>
          {new Date(line.ts).toLocaleTimeString(intlLocale())}
        </time>
        <Badge variant={LEVEL_VARIANT[line.level] ?? "outline"} className="shrink-0 uppercase">
          {line.level}
        </Badge>
        <span className="mt-1 shrink-0 text-muted" title={t(`kinds.${line.kind}`)}>
          <KindIcon aria-label={t(`kinds.${line.kind}`)} className="size-3.5" />
        </span>
        <span className="min-w-0 break-all">{line.msg}</span>
      </button>
      {open ? (
        <dl className="ms-6 mb-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 rounded-sm bg-surface-2 px-2 py-1 font-sans text-[12px]">
          <Detail label={t("details.version")} value={line.version} />
          <Detail label={t("details.task")} value={line.task_id} />
          <Detail label={t("details.trigger")} value={line.trigger} />
          {line.truncated ? <Detail label={t("details.truncated")} value={t("details.yes")} /> : null}
          {Object.entries(line.fields ?? {}).map(([k, v]) => (
            <Detail key={k} label={k} value={typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)} />
          ))}
        </dl>
      ) : null}
    </li>
  );
}

function Detail({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="contents">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-all font-mono">{value === null ? <NoData inline /> : value}</dd>
    </div>
  );
}
