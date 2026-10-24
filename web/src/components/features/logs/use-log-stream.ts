import { useCallback, useEffect, useRef, useState } from "react";

// Shape from docs/reference/api.md §8.6 (one LogLine per SSE `log` event).
export type LogLine = {
  seq: number;
  ts: number;
  level: "debug" | "info" | "warn" | "error";
  version: number | null;
  task_id: string | null;
  trigger: string | null;
  kind: "runtime" | "build" | "system";
  msg: string;
  truncated: boolean;
  // Structured std:log fields; absent on plain records.
  fields?: Record<string, unknown> | null;
};

export type LogLevel = "" | "debug" | "info" | "warn" | "error";
export type ConnState = "connecting" | "connected" | "reconnecting" | "closed";

const MAX_LINES = 1000;

function append(prev: LogLine[], add: LogLine[]): LogLine[] {
  return [...prev, ...add].slice(-MAX_LINES);
}

function parseData<T>(raw: unknown): T | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// useLogStream follows the app's SSE log route. The browser EventSource resumes with Last-Event-ID on
// its own; seq de-duplicates replayed lines. While paused, new lines are held in a buffer.
export function useLogStream(org: string, app: string, level: LogLevel) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [gap, setGap] = useState(false);
  const [terminal, setTerminal] = useState<string | null>(null);
  const [paused, setPausedState] = useState(false);
  const [buffered, setBuffered] = useState(0);

  const pausedRef = useRef(false);
  const bufferRef = useRef<LogLine[]>([]);
  const seenRef = useRef(new Set<number>());

  useEffect(() => {
    setLines([]);
    setGap(false);
    setTerminal(null);
    setBuffered(0);
    bufferRef.current = [];
    seenRef.current = new Set();

    const qs = level ? `?level=${level}` : "";
    const es = new EventSource(`/api/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}/logs${qs}`);
    setConn("connecting");

    es.addEventListener("open", () => setConn("connected"));
    es.addEventListener("log", (e) => {
      const line = parseData<LogLine>((e as MessageEvent).data);
      if (!line || seenRef.current.has(line.seq)) return;
      seenRef.current.add(line.seq);
      if (pausedRef.current) {
        bufferRef.current = [...bufferRef.current, line];
        setBuffered(bufferRef.current.length);
        return;
      }
      setLines((prev) => append(prev, [line]));
    });
    es.addEventListener("gap", () => setGap(true));
    es.addEventListener("error", (e) => {
      // A server `event: error` carries a body; a dropped connection is a bare error event.
      if (typeof (e as MessageEvent).data === "string") {
        const body = parseData<{ message?: string }>((e as MessageEvent).data);
        setTerminal(body?.message ?? "The log stream ended.");
        es.close();
        setConn("closed");
        return;
      }
      setConn(es.readyState === 2 ? "closed" : "reconnecting");
    });

    return () => es.close();
  }, [org, app, level]);

  const setPaused = useCallback((next: boolean) => {
    pausedRef.current = next;
    setPausedState(next);
    if (!next && bufferRef.current.length > 0) {
      const held = bufferRef.current;
      bufferRef.current = [];
      setBuffered(0);
      setLines((prev) => append(prev, held));
    }
  }, []);

  const clear = useCallback(() => {
    setLines([]);
    setGap(false);
    bufferRef.current = [];
    setBuffered(0);
  }, []);

  return { lines, conn, gap, terminal, paused, buffered, setPaused, clear };
}
