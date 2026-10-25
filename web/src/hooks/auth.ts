import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, setCsrfToken } from "@/lib/api";
import type { User } from "@/lib/types";

export type AuthConfig = {
  password_login_disabled: boolean;
  providers: { id: "github" | "google" | "oidc"; name: string }[];
};

export type SessionResp = { user: User; csrf: string };
export type LoginResp = { mfa_required: true } | ({ mfa_required: false } & SessionResp);

export type SetupReq = { setup_token: string; email: string; name: string; password: string };
export type InvitePreview = { email: string; org_name: string | null };

// Form-driven mutations skip the global toast: their errors (invalid_credentials, invalid_code,
// rate_limited, 422 fields) are shown inline next to the form.
const inline = { skipGlobalError: true } as const;

export function useAuthProviders() {
  return useQuery({
    queryKey: ["auth", "providers"],
    queryFn: () => api.get<AuthConfig>("/auth/providers"),
  });
}

export function useSetupStatus() {
  return useQuery({
    queryKey: ["setup"],
    queryFn: () => api.get<{ needed: boolean }>("/setup"),
  });
}

// A new session starts from an empty cache: nothing from a previous user in this tab survives.
export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    meta: inline,
    mutationFn: (body: { email: string; password: string }) => api.post<LoginResp>("/auth/login", body),
    onSuccess: (data) => {
      if (!data.mfa_required) {
        qc.removeQueries();
        setCsrfToken(data.csrf);
      }
    },
  });
}

export function useMfa() {
  const qc = useQueryClient();
  return useMutation({
    meta: inline,
    mutationFn: (body: { code: string }) => api.post<SessionResp>("/auth/mfa", body),
    onSuccess: (data) => {
      qc.removeQueries();
      setCsrfToken(data.csrf);
    },
  });
}

export function useSetup() {
  const qc = useQueryClient();
  return useMutation({
    meta: inline,
    mutationFn: (body: SetupReq) => api.post<SessionResp>("/setup", body),
    onSuccess: (data) => {
      qc.removeQueries();
      setCsrfToken(data.csrf);
    },
  });
}

// useLogout clears the CSRF token and the whole query cache, even when the request fails.
export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>("/auth/logout"),
    onSettled: () => {
      setCsrfToken(null);
      qc.removeQueries();
    },
  });
}

export function useChangePassword() {
  return useMutation({
    meta: inline,
    mutationFn: (body: { current_password: string; new_password: string }) =>
      api.put<void>("/me/password", body),
  });
}

export function useInvite(token: string) {
  return useQuery({
    queryKey: ["invite", token],
    queryFn: () => api.get<InvitePreview>(`/invites/accept/${encodeURIComponent(token)}`),
    retry: false,
  });
}

export function useAcceptInvite(token: string) {
  return useMutation({
    meta: inline,
    mutationFn: (body: { name: string; password: string }) =>
      api.post<{ email: string }>(`/invites/accept/${encodeURIComponent(token)}`, body),
  });
}
