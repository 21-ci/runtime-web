import { Pause, Play, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { type ConnState, type LogLevel, type LogLine, useLogStream } from "./use-log-stream";

// ALL_LEVELS stands in for "no minimum level"; Radix Select items cannot have an empty value.
const ALL_LEVELS = "all";

const CONN_LABEL: Record<ConnState, string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  closed: "Disconnected",
};

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
  const [level, setLevel] = useState<LogLevel>("");
  const [filter, setFilter] = useState("");
  const stream = useLogStream(org, app, level);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? stream.lines.filter((l) => l.msg.toLowerCase().includes(q)) : stream.lines;
  }, [stream.lines, filter]);

  return (
    <section className={cn("flex min-h-0 flex-col", compact ? "h-full" : "flex-1 gap-3")} aria-labelledby={compact ? undefined : "logs-heading"} aria-label={compact ? "Logs" : undefined}>
      <div className={cn("flex flex-wrap items-center gap-2", compact ? "border-b border-line px-2 py-1.5" : "")}>
        {!compact ? (
          <h2 id="logs-heading" className="mr-auto text-[15px] font-semibold">
            Live logs
          </h2>
        ) : null}
        <Input
          aria-label="Filter lines"
          placeholder="Filter lines…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className={cn("w-48 shadow-none", compact ? "h-7 text-[13px]" : "h-8")}
        />
        <Select value={level || ALL_LEVELS} onValueChange={(v) => setLevel(v === ALL_LEVELS ? "" : (v as LogLevel))}>
          <SelectTrigger aria-label="Minimum level" className={cn("w-auto min-w-36 shadow-none", compact ? "h-7 text-[13px]" : "h-8")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_LEVELS}>All levels</SelectItem>
            <SelectItem value="debug">Debug and up</SelectItem>
            <SelectItem value="info">Info and up</SelectItem>
            <SelectItem value="warn">Warn and up</SelectItem>
            <SelectItem value="error">Error only</SelectItem>
          </SelectContent>
        </Select>
        <span className={cn("flex items-center gap-2", compact ? "ml-auto" : "")}>
          <Badge variant={stream.conn === "connected" ? "success" : "outline"} dot={stream.conn === "connected"} aria-live="polite">
            {CONN_LABEL[stream.conn]}
          </Badge>
          {stream.paused && stream.buffered > 0 ? (
            <span className="text-[12px] text-muted">
              {stream.buffered === 1 ? "1 line buffered" : `${stream.buffered} lines buffered`}
            </span>
          ) : null}
          <Button variant="ghost" size={compact ? "sm" : "default"} onClick={() => stream.setPaused(!stream.paused)}>
            {stream.paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
            {stream.paused ? "Resume" : "Pause"}
          </Button>
          <Button variant="ghost" size={compact ? "sm" : "default"} onClick={stream.clear}>
            <Trash2 aria-hidden="true" />
            Clear
          </Button>
        </span>
      </div>

      {stream.gap ? (
        <p role="status" className="px-2 text-[12px] text-muted">
          <span>Some lines were skipped</span>
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
            {stream.lines.length === 0 ? "Lines appear here as the app handles requests." : "No lines match this filter."}
          </p>
        ) : (
          <EmptyState
            entity="logs"
            title={stream.lines.length === 0 ? "No log lines yet" : "No lines match this filter"}
            description={stream.lines.length === 0 ? "Lines appear here as the app handles requests." : "Clear the filter to see every line."}
          />
        )
      ) : (
        <ol
          aria-label="Log lines"
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
        {new Date(line.ts).toLocaleTimeString()}
      </time>
      <span className={cn("w-10 shrink-0 uppercase", LEVEL_CLASS[line.level] ?? "text-muted")}>{line.level}</span>
      <span className="break-all">{line.msg}</span>
      {line.fields ? <code className="break-all text-muted">{JSON.stringify(line.fields)}</code> : null}
    </li>
  );
}
