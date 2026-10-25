import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Org } from "@/hooks/orgs";
import { api } from "@/lib/api";
import type { OrgRole, User } from "@/lib/types";

// Shapes from docs/reference/api.md §2, §5.2 and §6. Timestamps are unix milliseconds.
export type Page<T> = { items: T[]; next_cursor: string | null };

export type AdminUser = User;
export type AdminOrg = Org;
export type AdminInvite = {
  id: string;
  email: string;
  org: { slug: string; name: string } | null;
  role: OrgRole | null;
  created_by: { id: string; name: string };
  created_at: number;
  expires_at: number;
};
export type AdminAuditEntry = {
  id: string;
  at: number;
  actor: { user_id: string | null; name: string | null; email: string | null };
  as_instance_admin: boolean;
  org: { id: string; slug: string } | null;
  action: string;
  target: string;
  detail: unknown;
};
export type OrgUsageRow = {
  app: string | null;
  day: string;
  invocations: number;
  cpu_ms: number;
  egress_bytes: number;
  storage_bytes: number;
};

export type AuditFilters = { org: string; actor: string; action: string };

// withQuery appends the defined, non-empty params to a path.
export function withQuery(path: string, params: Record<string, string | number | undefined>) {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") sp.set(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

// lastDays returns the inclusive YYYY-MM-DD range ending today (local time).
export function lastDays(days: number) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: isoDay(from), to: isoDay(to) };
}

function isoDay(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const adminPrefix = ["admin"] as const;

export function useAdminUsers(q: string) {
  return useInfiniteQuery({
    queryKey: [...adminPrefix, "users", q],
    queryFn: ({ pageParam }) =>
      api.get<Page<AdminUser>>(withQuery("/admin/users", { q, cursor: pageParam, limit: 50 })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

// useUserOptions lists up to 200 users for the owner and actor pickers.
export function useUserOptions() {
  return useQuery({
    queryKey: [...adminPrefix, "user-options"],
    queryFn: () => api.get<Page<AdminUser>>("/admin/users?limit=200").then((r) => r.items),
  });
}

export function useAdminOrgs() {
  return useQuery({
    queryKey: [...adminPrefix, "orgs"],
    queryFn: () => api.get<{ items: AdminOrg[] }>("/admin/orgs").then((r) => r.items),
  });
}

export function useOrgUsage(slug: string, range: { from: string; to: string }) {
  return useQuery({
    queryKey: [...adminPrefix, "org-usage", slug, range.from, range.to],
    queryFn: () =>
      api
        .get<{ items: OrgUsageRow[] }>(withQuery(`/admin/orgs/${encodeURIComponent(slug)}/usage`, range))
        .then((r) => r.items),
  });
}

export function useAdminInvites() {
  return useQuery({
    queryKey: [...adminPrefix, "invites"],
    queryFn: () => api.get<{ items: AdminInvite[] }>("/admin/invites").then((r) => r.items),
  });
}

export function useAdminAudit(filters: AuditFilters) {
  return useInfiniteQuery({
    queryKey: [...adminPrefix, "audit", filters.org, filters.actor, filters.action],
    queryFn: ({ pageParam }) =>
      api.get<Page<AdminAuditEntry>>(
        withQuery("/admin/audit", {
          org: filters.org,
          actor: filters.actor,
          action: filters.action,
          cursor: pageParam,
          limit: 50,
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

// useAdminMutations invalidate every admin read, since a user, org or invite change shows up on
// several pages (owner pickers, usage rows, audit actors).
function useInvalidateAdmin() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: adminPrefix });
}

// Form-driven mutations show their errors inline, so they skip the global toast.
const inline = { skipGlobalError: true } as const;

export function useCreateAdminUser() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    meta: inline,
    mutationFn: (body: { email: string; name: string; instance_admin?: boolean }) =>
      api.post<{ user: AdminUser; temp_password: string }>("/admin/users", body),
    onSuccess: () => invalidate(),
  });
}

export function usePatchAdminUser() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: { disabled?: boolean; instance_admin?: boolean } }) =>
      api.patch<AdminUser>(`/admin/users/${encodeURIComponent(id)}`, body),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteAdminUser() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    meta: inline,
    mutationFn: (id: string) => api.del<void>(`/admin/users/${encodeURIComponent(id)}`),
    onSuccess: () => invalidate(),
  });
}

export function useResetAdminPassword() {
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ temp_password: string }>(`/admin/users/${encodeURIComponent(id)}/reset-password`),
  });
}

export function useResetAdminTotp() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/admin/users/${encodeURIComponent(id)}/totp`),
    onSuccess: () => invalidate(),
  });
}

export function useCreateAdminOrg() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    meta: inline,
    mutationFn: (body: { slug: string; name: string; owner_user_id: string }) =>
      api.post<AdminOrg>("/admin/orgs", body),
    onSuccess: () => invalidate(),
  });
}

export function useRenameAdminOrg() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    meta: inline,
    mutationFn: ({ slug, name }: { slug: string; name: string }) =>
      api.patch<AdminOrg>(`/admin/orgs/${encodeURIComponent(slug)}`, { name }),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteAdminOrg() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    meta: inline,
    mutationFn: (slug: string) => api.del<void>(`/admin/orgs/${encodeURIComponent(slug)}`),
    onSuccess: () => invalidate(),
  });
}

export function useCreateAdminInvite() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    meta: inline,
    mutationFn: (body: { email: string; org?: string; role?: OrgRole }) =>
      api.post<{ invite: AdminInvite; link: string }>("/admin/invites", body),
    onSuccess: () => invalidate(),
  });
}

export function useRevokeAdminInvite() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/admin/invites/${encodeURIComponent(id)}`),
    onSuccess: () => invalidate(),
  });
}

// errorMessage turns a failed admin action into text for an inline message or a toast (the shared
// mapper, so admin errors translate like the rest of the console).
export { errorMessage } from "@/lib/error-message";
