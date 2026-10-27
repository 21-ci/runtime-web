import { useCallback, useEffect, useRef, useState } from "react";

import { i18n } from "@/lib/i18n";

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

// Auto-retry after the browser gives up on the stream: 1 s, 2 s, 4 s ... capped at 30 s, then the
// Reconnect button is the only way back.
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 30_000;
export const MAX_AUTO_RETRIES = 6;

export function retryDelay(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
}

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
  // Bumping `generation` reopens the EventSource; `attemptRef` counts auto-retries since the last open.
  const [generation, setGeneration] = useState(0);
  const attemptRef = useRef(0);

  // A new stream (org, app or level changed) starts from empty state; reset during render rather
  // than synchronously inside the effect.
  const streamKey = `${org}\u0000${app}\u0000${level}`;
  const [activeKey, setActiveKey] = useState(streamKey);
  if (activeKey !== streamKey) {
    setActiveKey(streamKey);
    setLines([]);
    setGap(false);
    setTerminal(null);
    setBuffered(0);
    setConn("connecting");
  }

  // A new stream key resets the retry budget; a reconnect of the same stream keeps seen lines so
  // replayed seqs are not shown twice.
  const keyRef = useRef(streamKey);
  useEffect(() => {
    if (keyRef.current !== streamKey) {
      keyRef.current = streamKey;
      attemptRef.current = 0;
      bufferRef.current = [];
      seenRef.current = new Set();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;

    const qs = level ? `?level=${level}` : "";
    const es = new EventSource(`/api/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}/logs${qs}`);

    es.addEventListener("open", () => {
      attemptRef.current = 0;
      setConn("connected");
    });
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
        setTerminal(body?.message ?? i18n.t("logs:streamEnded"));
        es.close();
        setConn("closed");
        return;
      }
      if (es.readyState !== 2) {
        setConn("reconnecting");
        return;
      }
      // The browser stopped retrying (for example after a non-2xx reply): retry ourselves with backoff.
      if (attemptRef.current < MAX_AUTO_RETRIES) {
        const wait = retryDelay(attemptRef.current);
        attemptRef.current += 1;
        setConn("reconnecting");
        timer = setTimeout(() => setGeneration((g) => g + 1), wait);
        return;
      }
      setConn("closed");
    });

    return () => {
      if (timer) clearTimeout(timer);
      es.close();
    };
  }, [org, app, level, streamKey, generation]);

  const reconnect = useCallback(() => {
    attemptRef.current = 0;
    setTerminal(null);
    setConn("connecting");
    setGeneration((g) => g + 1);
  }, []);

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

  return { lines, conn, gap, terminal, paused, buffered, setPaused, clear, reconnect };
}
