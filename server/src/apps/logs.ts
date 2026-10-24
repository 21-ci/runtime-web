// Log stream (api-web §8.6, design §3 "logs SSE"). No hub: each SSE request is
// its own task. It polls GET …/logs by cursor every second through rtctl, emits
// `id: <seq>` + `event: log`, and ends before 25 s with `retry: 500` so
// EventSource reconnects with Last-Event-ID. The runtime pages by opaque cursor,
// so the cursor after each seq we sent is kept in KV (`sse:<svc>:<seq>`, 10 min);
// on a KV miss the stream pages from the start and skips seq <= Last-Event-ID.

import type { Kv } from "../storage/types.ts";
import type * as T from "../runtime/types.ts";
import { AppError } from "../http/errors.ts";
import { mapRuntimeError as mapRuntime } from "../runtime/errors.ts";
import { logLine, type OrgCtx, type Resolved } from "./service.ts";

export const sseTiming = {
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  pollMs: 1000,
  /** End the stream once this much wall time has passed (task wall limit is 30 s). */
  maxMs: 24_000,
  /** Fetch budget: 50 per task, keep headroom for resolve/auth. */
  maxPolls: 40,
  pingMs: 15_000,
  retryMs: 500,
};

export const LOG_RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const cursorKey = (svc: string, seq: number) => `sse:${svc}:${seq}`;

export function sseResponse(c: OrgCtx, app: Resolved, kv: Kv, now: () => number, lastId: number | null, level: string): Response {
  const enc = new TextEncoder();
  const minRank = level ? (LOG_RANK[level] ?? 0) : 0;
  const stream = new ReadableStream<Uint8Array>({
    async start(ctl) {
      const write = (s: string) => ctl.enqueue(enc.encode(s));
      const start = now();
      let lastWrite = start;
      let after = lastId ?? 0;
      let cursor: string | undefined = lastId !== null ? (await kv.get<string>(cursorKey(app.id, lastId))) ?? undefined : undefined;
      try {
        for (let polls = 0; polls < sseTiming.maxPolls; polls++) {
          const q: T.LogQuery = { limit: 200 };
          if (cursor) q.cursor = cursor;
          let page: T.Page<T.LogLine>;
          try {
            page = await c.cli.logs(app.id, q);
          } catch (e) {
            const m = mapRuntime(e);
            const err = m instanceof AppError ? m : new AppError(500, "internal", "internal error");
            if (err.status === 404 || err.status === 403) {
              write(`event: error\ndata: ${JSON.stringify({ code: err.code, message: err.message })}\n\n`);
              ctl.close();
              return;
            }
            break; // transient: let the client reconnect
          }
          let sent = 0;
          for (const l of page.items) {
            if (l.seq <= after) continue;
            after = l.seq;
            if ((LOG_RANK[l.level] ?? 0) < minRank) continue;
            write(`id: ${l.seq}\nevent: log\ndata: ${JSON.stringify(logLine(l))}\n\n`);
            sent++;
          }
          if (page.next_cursor) cursor = page.next_cursor;
          if (after > 0 && cursor) await kv.set(cursorKey(app.id, after), cursor, { ttlSeconds: 600 });
          if (sent) lastWrite = now();
          const more = page.items.length > 0 && page.next_cursor !== null && page.next_cursor !== q.cursor;
          if (now() - start + (more ? 0 : sseTiming.pollMs) >= sseTiming.maxMs) break;
          if (now() - lastWrite >= sseTiming.pingMs) {
            write(": ping\n\n");
            lastWrite = now();
          }
          if (!more || page.items.length < 200) await sseTiming.sleep(sseTiming.pollMs);
        }
        write(`retry: ${sseTiming.retryMs}\n\n`);
        ctl.close();
      } catch (e) {
        console.error("apps: log stream", String(e));
        try {
          ctl.close();
        } catch {
          // already closed (client left)
        }
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" },
  });
}
