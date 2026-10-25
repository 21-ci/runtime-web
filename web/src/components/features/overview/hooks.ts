import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { appPath } from "@/components/features/app-header/hooks";
import { api } from "@/lib/api";

// Runtime stats pass through as an object; the overview reads the keys it knows and ignores the rest.
export type AppStats = {
  requests?: number;
  errors?: number;
  error_rate?: number;
  p50_ms?: number;
  p95_ms?: number;
  p99_ms?: number;
  [key: string]: unknown;
};

export type AppEvent = { id: string; ts: number; kind: string; data: unknown };
type EventsPage = { items: AppEvent[]; next_cursor: string | null };

export function useAppStats(org: string, app: string, window = "5m") {
  return useQuery({
    queryKey: ["app-stats", org, app, window],
    queryFn: () => api.get<AppStats>(`${appPath(org, app)}/stats?window=${window}`),
  });
}

export function useAppEvents(org: string, app: string) {
  return useInfiniteQuery({
    queryKey: ["app-events", org, app],
    queryFn: ({ pageParam }) => {
      const cursor = pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : "";
      return api.get<EventsPage>(`${appPath(org, app)}/events?limit=50${cursor}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
}
