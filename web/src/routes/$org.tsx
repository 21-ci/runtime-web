import { useEffect } from "react";
import { createFileRoute, Outlet } from "@tanstack/react-router";

import { AppShell } from "@/components/layout/app-shell";
import { writeLastOrg } from "@/components/layout/last-org";

// Every org-scoped page renders inside the shell. Org changes come from the switcher, which clears
// the query cache before navigating here with the new slug.
function OrgLayout() {
  const { org } = Route.useParams();
  // Instance-admin pages keep this org in the shell (switcher, projects, ⌘K).
  useEffect(() => writeLastOrg(org), [org]);
  return (
    <AppShell org={org}>
      <Outlet />
    </AppShell>
  );
}

export const Route = createFileRoute("/$org")({
  component: OrgLayout,
});
