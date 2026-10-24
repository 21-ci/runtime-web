import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { type ConnState, type LogLevel, type LogLine, useLogStream } from "./use-log-stream";

// ALL_LEVELS stands in for "no minimum level"; Radix Select items cannot have an empty value.
const ALL_LEVELS = "all";

const CONN_LABEL: Record<ConnState, string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  closed: "Disconnected",
};

// LogsView shows the live log stream of one app. Pause holds new lines in a buffer, the level select
// is a server-side minimum severity, and the text filter narrows what is shown.
export function LogsView({ org, app }: { org: string; app: string }) {
  const [level, setLevel] = useState<LogLevel>("");
  const [filter, setFilter] = useState("");
  const stream = useLogStream(org, app, level);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? stream.lines.filter((l) => l.msg.toLowerCase().includes(q)) : stream.lines;
  }, [stream.lines, filter]);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="logs-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="logs-heading" className="mr-auto text-lg font-semibold">
          Logs
        </h2>
        <Badge variant={stream.conn === "connected" ? "default" : "outline"} aria-live="polite">
          {CONN_LABEL[stream.conn]}
        </Badge>
        <Button variant="secondary" onClick={() => stream.setPaused(!stream.paused)}>
          {stream.paused ? "Resume" : "Pause"}
        </Button>
        {stream.paused && stream.buffered > 0 ? (
          <span className="text-sm text-muted">
            {stream.buffered === 1 ? "1 line buffered" : `${stream.buffered} lines buffered`}
          </span>
        ) : null}
        <Button variant="secondary" onClick={stream.clear}>
          Clear
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="Filter lines"
          placeholder="Filter lines"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-xs"
        />
        <Select value={level || ALL_LEVELS} onValueChange={(v) => setLevel(v === ALL_LEVELS ? "" : (v as LogLevel))}>
          <SelectTrigger aria-label="Minimum level" className="h-[34px] w-auto min-w-40 bg-panel px-2 text-sm">
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
      </div>

      {stream.gap ? (
        <p role="status" className="text-sm text-muted">
          <span>Some lines were skipped</span>
        </p>
      ) : null}
      {stream.terminal ? (
        <p role="alert" className="text-sm text-danger">
          <span>{stream.terminal}</span>
        </p>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState entity="logs"
          title={stream.lines.length === 0 ? "No log lines yet" : "No lines match this filter"}
          description={
            stream.lines.length === 0 ? "Lines appear here as the app handles requests." : "Clear the filter to see every line."
          }
        />
      ) : (
        <ol
          aria-label="Log lines"
          className="max-h-[60vh] overflow-auto rounded-sm border border-line bg-panel p-2 font-mono text-xs"
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
    <li className="flex gap-2 py-0.5">
      <time className="shrink-0 text-muted" dateTime={new Date(line.ts).toISOString()}>
        {new Date(line.ts).toLocaleTimeString()}
      </time>
      <span className="shrink-0 text-muted">{line.level}</span>
      <span className="break-all">{line.msg}</span>
      {line.fields ? <code className="break-all text-muted">{JSON.stringify(line.fields)}</code> : null}
    </li>
  );
}
