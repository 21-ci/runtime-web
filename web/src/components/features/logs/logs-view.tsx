import { Pause, Play, RotateCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { intlLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import { type ConnState, type LogLevel, type LogLine, useLogStream } from "./use-log-stream";

// ALL_LEVELS stands in for "no minimum level"; Radix Select items cannot have an empty value.
const ALL_LEVELS = "all";

const CONN_KEY = {
  connecting: "conn.connecting",
  connected: "conn.connected",
  reconnecting: "conn.reconnecting",
  closed: "conn.closed",
} as const satisfies Record<ConnState, string>;

const LEVEL_OPTIONS = [
  { value: ALL_LEVELS, labelKey: "levels.all" },
  { value: "debug", labelKey: "levels.debug" },
  { value: "info", labelKey: "levels.info" },
  { value: "warn", labelKey: "levels.warn" },
  { value: "error", labelKey: "levels.error" },
] as const;

const LEVEL_CLASS: Record<string, string> = {
  error: "text-tag-red-text",
  warn: "text-tag-yellow-text",
  info: "text-tag-blue-text",
  debug: "text-muted",
};

// LogsView shows the live log stream of one app. Pause holds new lines in a buffer, the level
// select is a server-side minimum severity, and the text filter narrows what is shown. `compact`
// is the dock inside the code page: no heading, full height, smaller controls.
export function LogsView({ org, app, compact = false }: { org: string; app: string; compact?: boolean }) {
  const { t } = useTranslation("logs");
  const [level, setLevel] = useState<LogLevel>("");
  const [filter, setFilter] = useState("");
  const stream = useLogStream(org, app, level);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? stream.lines.filter((l) => l.msg.toLowerCase().includes(q)) : stream.lines;
  }, [stream.lines, filter]);

  return (
    <section className={cn("flex min-h-0 flex-col", compact ? "h-full" : "flex-1 gap-3")} aria-labelledby={compact ? undefined : "logs-heading"} aria-label={compact ? t("compactLabel") : undefined}>
      <div className={cn("flex flex-wrap items-center gap-2", compact ? "border-b border-line px-2 py-1.5" : "")}>
        {!compact ? (
          <h2 id="logs-heading" className="mr-auto text-[15px] font-semibold">
            {t("title")}
          </h2>
        ) : null}
        <Input
          aria-label={t("filterLabel")}
          placeholder={t("filterPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className={cn("w-48 shadow-none", compact ? "h-7 text-[13px]" : "h-8")}
        />
        <Select value={level || ALL_LEVELS} onValueChange={(v) => setLevel(v === ALL_LEVELS ? "" : (v as LogLevel))}>
          <SelectTrigger aria-label={t("levelLabel")} className={cn("w-auto min-w-36 shadow-none", compact ? "h-7 text-[13px]" : "h-8")}>
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
        <span className={cn("flex items-center gap-2", compact ? "ml-auto" : "")}>
          <Badge variant={stream.conn === "connected" ? "success" : "outline"} dot={stream.conn === "connected"} aria-live="polite">
            {t(CONN_KEY[stream.conn])}
          </Badge>
          {stream.conn === "closed" ? (
            <Button variant="secondary" size={compact ? "sm" : "default"} onClick={stream.reconnect}>
              <RotateCw aria-hidden="true" />
              {t("reconnect")}
            </Button>
          ) : null}
          {stream.paused && stream.buffered > 0 ? (
            <span className="text-[12px] text-muted">{t("buffered", { count: stream.buffered })}</span>
          ) : null}
          <Button variant="ghost" size={compact ? "sm" : "default"} onClick={() => stream.setPaused(!stream.paused)}>
            {stream.paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
            {stream.paused ? t("resume") : t("pause")}
          </Button>
          <Button variant="ghost" size={compact ? "sm" : "default"} onClick={stream.clear}>
            <Trash2 aria-hidden="true" />
            {t("clear")}
          </Button>
        </span>
      </div>

      {stream.gap ? (
        <p role="status" className="px-2 text-[12px] text-muted">
          <span>{t("gap")}</span>
        </p>
      ) : null}
      {stream.terminal ? (
        <p role="alert" className="px-2 text-[13px] text-danger-text">
          <span>{stream.terminal}</span>
        </p>
      ) : null}

      {visible.length === 0 ? (
        compact ? (
          <p className="px-3 py-4 text-[13px] text-muted">
            {stream.lines.length === 0 ? t("empty.compact") : t("empty.compactNoMatch")}
          </p>
        ) : (
          <EmptyState
            entity="logs"
            title={stream.lines.length === 0 ? t("empty.title") : t("empty.noMatchTitle")}
            description={stream.lines.length === 0 ? t("empty.description") : t("empty.noMatchDescription")}
          />
        )
      ) : (
        <ol
          aria-label={t("linesLabel")}
          className={cn(
            "min-h-0 flex-1 overflow-auto bg-panel font-mono text-[12px] leading-[1.7]",
            compact ? "px-2 py-1" : "max-h-[calc(100dvh-220px)] rounded-lg border border-line p-2 shadow-card",
          )}
        >
          {visible.map((l) => (
            <LogRow key={l.seq} line={l} />
          ))}
        </ol>
      )}
    </section>
  );
}

function LogRow({ line }: { line: LogLine }) {
  return (
    <li className="flex gap-3 px-1 hover:bg-hover">
      <time className="shrink-0 tabular-nums text-muted" dateTime={new Date(line.ts).toISOString()}>
        {new Date(line.ts).toLocaleTimeString(intlLocale())}
      </time>
      <span className={cn("w-10 shrink-0 uppercase", LEVEL_CLASS[line.level] ?? "text-muted")}>{line.level}</span>
      <span className="break-all">{line.msg}</span>
      {line.fields ? <code className="break-all text-muted">{JSON.stringify(line.fields)}</code> : null}
    </li>
  );
}
