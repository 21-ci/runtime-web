import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

// Shapes from docs/reference/api.md §8.1. Runtime blocks are passed through; each present block replaces
// the whole block on the server (no merge), so every form sends the complete block it edits.
export type AppAccess = "public" | "key" | "internal";
export type Ingress = {
  methods?: string[];
  path_prefixes?: string[];
  ip_allow?: string[];
  rate_limit?: Record<string, unknown>;
};
export type AppDetail = {
  slug: string;
  name: string | null;
  project: string;
  environment: string;
  live_version: number | null;
  etag: string;
  runtime: string;
  profile: string | null;
  access: AppAccess;
  url: string;
  scaling: { min_instances?: number; max_instances?: number } | null;
  ingress: Ingress | null;
  egress: Record<string, unknown> | null;
  call: { allowed_callers: string[] } | null;
  status: {
    build_state: string;
    tier: string;
    last_error: string | null;
    inflight: number;
    admission: Record<string, unknown> | null;
  };
  limits: {
    requested: Record<string, unknown> | null;
    effective: Record<string, unknown>;
    source: "plan" | "profile" | "service";
  };
};

// AppPatch carries only the blocks one form owns. Keys left out are unchanged on the server.
export type AppPatch = {
  name?: string | null;
  profile?: string | null;
  access?: AppAccess;
  scaling?: { min_instances?: number; max_instances?: number };
  ingress?: Ingress;
  egress?: Record<string, unknown>;
  call?: { allowed_callers: string[] };
  limits?: Record<string, unknown>;
};

export type CreatedToken = {
  token: { id: string; name: string; scopes: string[]; apps: string[] };
  secret: string;
};

function enc(s: string) {
  return encodeURIComponent(s);
}

export function appKey(org: string, app: string) {
  return ["app", org, app] as const;
}

export function useAppDetail(org: string, app: string) {
  return useQuery({
    queryKey: appKey(org, app),
    queryFn: () => api.get<AppDetail>(`/orgs/${enc(org)}/apps/${enc(app)}`),
  });
}

// usePatchApp sends PATCH with If-Match set to the etag the form was loaded with. A 409 stale comes
// back as an ApiError; the global handler shows the reload toast, so forms only handle 422 fields.
export function usePatchApp(org: string, app: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ etag, body }: { etag: string; body: AppPatch }) =>
      api.patch<AppDetail>(`/orgs/${enc(org)}/apps/${enc(app)}`, body, { ifMatch: etag }),
    onSuccess: (updated) => {
      qc.setQueryData(appKey(org, app), updated);
      void qc.invalidateQueries({ queryKey: ["apps", org] });
    },
  });
}

export function useCreateInvokeToken(org: string, app: string) {
  return useMutation({
    meta: { skipGlobalError: true },
    mutationFn: () =>
      api.post<CreatedToken>(`/orgs/${enc(org)}/tokens`, {
        name: `invoke ${app}`,
        scopes: ["invoke"],
        apps: [app],
        expires_at: null,
      }),
  });
}

export function useDeleteApp(org: string, app: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipGlobalError: true },
    mutationFn: () => api.del<void>(`/orgs/${enc(org)}/apps/${enc(app)}`),
    onSuccess: () => {
      qc.removeQueries({ queryKey: appKey(org, app) });
      void qc.invalidateQueries({ queryKey: ["apps", org] });
    },
  });
}
