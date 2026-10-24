import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Me } from "@/routes/__root";
import { api } from "@/lib/api";

// Shapes from docs/api-web.md §5.1.
export type SessionInfo = {
  id: string;
  ip: string;
  ua: string;
  created_at: number;
  last_seen_at: number;
  current: boolean;
};

export type LoginEvent = {
  id: string;
  at: number;
  ip: string;
  ua: string;
  method: "password" | "oauth" | "invite";
  result: "ok" | "bad_password" | "bad_totp" | "rate_limited" | "disabled" | "sso_only" | "mfa_pending";
};

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<Me>("/me"),
  });
}

export function useSessions() {
  return useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.get<{ items: SessionInfo[] }>("/me/sessions").then((r) => r.items),
  });
}

export function useLogins() {
  return useQuery({
    queryKey: ["logins"],
    queryFn: () => api.get<{ items: LoginEvent[] }>("/me/logins?limit=50").then((r) => r.items),
  });
}

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/me/sessions/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });
}

export function useRevokeOtherSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ revoked: number }>("/me/sessions/revoke-others"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });
}

export function useEnrollTotp() {
  return useMutation({
    mutationFn: () => api.post<{ otpauth_url: string }>("/me/totp/enroll"),
  });
}

// useConfirmTotp does not refresh the profile: the recovery codes are on screen until the user
// confirms they saved them, and a refetch that flips the 2FA section would unmount them.
export function useConfirmTotp() {
  return useMutation({
    meta: { skipGlobalError: true },
    mutationFn: (code: string) => api.post<{ recovery_codes: string[] }>("/me/totp/confirm", { code }),
  });
}

export function useDisableTotp() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipGlobalError: true },
    mutationFn: (body: { password: string; code: string }) => api.post<void>("/me/totp/disable", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
}

export function useRegenerateRecoveryCodes() {
  return useMutation({
    meta: { skipGlobalError: true },
    mutationFn: (body: { password: string }) => api.post<{ recovery_codes: string[] }>("/me/recovery-codes", body),
  });
}
