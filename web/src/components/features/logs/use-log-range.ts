import { useInfiniteQuery } from "@tanstack/react-query";

import { ApiError } from "@/lib/api";

import { readQuery, type Bounds, type LineFilter } from "./log-filter";
import type { LogLine } from "./use-log-stream";

const PAGE_LINES = 1000;

type RangePage = { lines: LogLine[]; next: number | null };

// The server's range read is ndjson of one page, ended by a truncation line when more exist. The
// runtime answers oldest first, so the next page starts at the last line's time; seq drops what the two share.
async function readPage(url: string, since: number, signal: AbortSignal): Promise<RangePage> {
  const res = await fetch(url, { signal, credentials: "same-origin" });
  if (!res.ok || !res.body) throw new ApiError(res.status, "log_range_failed", await res.text());
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const lines: LogLine[] = [];
  let tail = "";
  let cut = false;
  const take = (raw: string) => {
    if (!raw.trim()) return;
    const row = JSON.parse(raw) as LogLine | { truncated: true; limit: number };
    if ("limit" in row) cut = true;
    else lines.push(row);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const parts = (tail + value).split("\n");
    tail = parts.pop() ?? "";
    parts.forEach(take);
    if (lines.length >= PAGE_LINES) {
      cut = true;
      await reader.cancel();
      tail = "";
      break;
    }
  }
  take(tail);
  const last = lines[lines.length - 1];
  return { lines, next: cut && last && last.ts > since ? last.ts : null };
}

export function useLogRange(org: string, app: string, filter: Pick<LineFilter, "level" | "kind">, bounds: Bounds | null) {
  const base = `/api/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}/logs`;
  return useInfiniteQuery<RangePage, Error, { pages: RangePage[] }, readonly unknown[], number>({
    queryKey: ["log-range", org, app, filter.level ?? "", filter.kind ?? "", bounds?.since, bounds?.until],
    enabled: bounds !== null,
    initialPageParam: bounds?.since ?? 0,
    retry: false,
    refetchOnWindowFocus: false,
    getNextPageParam: (last) => last.next,
    queryFn: ({ pageParam, signal }) => {
      const b = bounds as Bounds;
      return readPage(`${base}?${readQuery(filter, { since: pageParam, until: b.until })}`, pageParam, signal);
    },
  });
}
