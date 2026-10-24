import { createFileRoute } from "@tanstack/react-router";

import { SecurityPage } from "@/components/features/security/security-page";
import { AppShell } from "@/components/layout/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrgs } from "@/hooks/orgs";

export const Route = createFileRoute("/me/security")({
  component: AccountSecurityRoute,
});

// Account security is per user, but it renders in the normal app shell. The shell needs an org
// scope for its sidebar, so it uses the user's first organization. A user with no organization
// gets the page without the sidebar.
function AccountSecurityRoute() {
  const orgs = useOrgs();
  if (orgs.isPending) return <Skeleton className="m-6 h-64 w-full" />;
  const first = orgs.data?.[0];
  if (!first) return <SecurityPage />;
  return (
    <AppShell org={first.slug}>
      <SecurityPage />
    </AppShell>
  );
}
