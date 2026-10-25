import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

import { BrandingEffects } from "@/components/features/branding/brand";
import { Toaster } from "@/components/ui/toast";
import { RuntimeStatusBanner } from "@/components/runtime-status-banner";
import { api, getCsrfToken, setCsrfToken } from "@/lib/api";
import type { OrgRole, User } from "@/lib/types";

type RouterContext = { queryClient: QueryClient };

export type Me = {
  user: User;
  csrf: string;
  orgs: { slug: string; name: string; role: OrgRole }[];
  policy: { require_2fa: boolean; password_login_disabled: boolean };
  mfa_enrollment_required: boolean;
};

// bootstrapSession loads GET /api/me after a reload (the CSRF token lives only in module memory).
// A 401 means signed out: the token stays cleared and no redirect happens here.
export async function bootstrapSession(): Promise<Me | null> {
  if (getCsrfToken()) return null;
  try {
    const me = await api.get<Me>("/me", { skipGate: true });
    setCsrfToken(me.csrf);
    return me;
  } catch {
    setCsrfToken(null);
    return null;
  }
}

function RootLayout() {
  return (
    <>
      <BrandingEffects />
      <RuntimeStatusBanner />
      <Outlet />
      <Toaster />
    </>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async () => {
    await bootstrapSession();
  },
  component: RootLayout,
});
