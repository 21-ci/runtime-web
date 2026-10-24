import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { AppSummary } from "@/hooks/orgs";

export type Ingress = {
  methods?: string[];
  path_prefixes?: string[];
  ip_allow?: string[];
  rate_limit?: object | null;
};

// AppView is the detail body of GET …/{app} (docs/reference/api.md §8.1). Only the fields this UI reads.
export type AppView = AppSummary & {
  etag: string;
  access: "public" | "key" | "internal";
  ingress: Ingress | null;
};

export function appPath(org: string, app: string) {
  return `/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}`;
}

export function useAppView(org: string, app: string) {
  return useQuery({
    queryKey: ["app", org, app],
    queryFn: () => api.get<AppView>(appPath(org, app)),
  });
}

// usePatchApp sends PATCH with If-Match. Blocks replace the whole runtime block, so callers pass
// the complete block. A 409 stale is toasted globally with a reload action.
export function usePatchApp(org: string, app: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ etag, body }: { etag: string; body: Record<string, unknown> }) =>
      api.patch<AppView>(appPath(org, app), body, { ifMatch: etag }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["app", org, app] });
      void qc.invalidateQueries({ queryKey: ["apps", org] });
    },
  });
}
