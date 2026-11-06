// File exports (docs/contributing/ui-guidelines.md rule 10): the view's own route with ?format=, streamed row by row
// and bounded. The first row is produced before the Response exists, so a failed first page is a normal error and a
// route can audit only what actually starts. A later failure breaks the stream, so a cut download looks cut.

import { invalid } from "./errors.ts";

export type ExportFormat = "csv" | "ndjson" | "txt";

/** Most rows one export writes; past it the file ends with a truncation line. */
export const MAX_EXPORT_ROWS = 100_000;

const CONTENT_TYPE: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  ndjson: "application/x-ndjson",
  txt: "text/plain; charset=utf-8",
};

/** The ?format= of a request: null when absent (the route answers as usual), 422 when not allowed here. */
export function exportFormat<F extends ExportFormat>(q: URLSearchParams, allowed: readonly F[]): F | null {
  const raw = q.get("format");
  if (raw === null) return null;
  if (!(allowed as readonly string[]).includes(raw)) throw invalid({ format: "not_one_of" });
  return raw as F;
}

/** One CSV cell. A text starting like a formula is quoted away, so a spreadsheet will not run log or audit text. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  let s = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (cells: readonly unknown[]): string => cells.map(csvCell).join(",");

/** ISO 8601 UTC for a millisecond timestamp; an unusable one stays empty rather than failing the whole file. */
export function isoTime(ms: unknown): string {
  return typeof ms === "number" && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : "";
}

/** An RFC 3339 bound of a read or an export; absent is an open end, anything else a 422. */
export function rangeBound(q: URLSearchParams, key: "since" | "until"): { text?: string; ms: number | null } {
  const raw = q.get(key);
  if (raw === null) return { ms: null };
  const ms = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(raw) ? Date.parse(raw) : Number.NaN;
  if (Number.isNaN(ms)) throw invalid({ [key]: "not_rfc3339" });
  return { text: raw, ms };
}

const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** `<parts…>-<kind>-<from>-<to>.<ext>` in UTC; from is "start" for an open range. */
export function exportFileName(parts: readonly string[], kind: string, from: number | null, to: number, ext: string): string {
  const safe = parts.map((p) => p.replace(/[^A-Za-z0-9_.-]/g, ""));
  return `${[...safe, kind, from === null ? "start" : stamp(from), stamp(to)].join("-")}.${ext}`;
}

const truncation = (format: ExportFormat, limit: number): string =>
  format === "ndjson" ? JSON.stringify({ truncated: true, limit }) : `# truncated at ${limit} rows`;

export interface ExportOptions<T> {
  fileName: string;
  format: ExportFormat;
  rows: AsyncIterable<T> | Iterable<T>;
  line: (row: T) => string;
  /** First line of the file (the CSV column names). */
  header?: string;
  maxRows?: number;
  /** A read for the page itself, not a file: no attachment header. */
  inline?: boolean;
}

export async function exportResponse<T>(o: ExportOptions<T>): Promise<Response> {
  const limit = o.maxRows ?? MAX_EXPORT_ROWS;
  const eol = o.format === "csv" ? "\r\n" : "\n";
  const it = Symbol.asyncIterator in o.rows ? o.rows[Symbol.asyncIterator]() : toAsync(o.rows[Symbol.iterator]());
  const enc = new TextEncoder();
  const first = await it.next();
  let next: IteratorResult<T> | null = first;
  let written = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      start(ctl) {
        if (o.header !== undefined) ctl.enqueue(enc.encode(o.header + eol));
      },
      // One row per pull: a slow client holds the upstream paging back.
      async pull(ctl) {
        try {
          const n: IteratorResult<T> = next ?? (await it.next());
          next = null;
          if (n.done) {
            ctl.close();
            return;
          }
          if (written >= limit) {
            ctl.enqueue(enc.encode(truncation(o.format, limit) + eol));
            ctl.close();
            await it.return?.();
            return;
          }
          written++;
          ctl.enqueue(enc.encode(o.line(n.value) + eol));
        } catch (e) {
          ctl.error(e);
        }
      },
      async cancel() {
        await it.return?.();
      },
    },
    { highWaterMark: 1 },
  );
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": CONTENT_TYPE[o.format],
      ...(o.inline ? {} : { "content-disposition": `attachment; filename="${o.fileName}"` }),
      "cache-control": "no-store",
    },
  });
}

function toAsync<T>(it: Iterator<T>): AsyncIterator<T> {
  return { next: async () => it.next() };
}
