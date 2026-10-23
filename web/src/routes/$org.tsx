import { createFileRoute, Outlet } from "@tanstack/react-router";

import { AppShell } from "@/components/layout/app-shell";

// Every org-scoped page renders inside the shell. Org changes come from the switcher, which clears
// the query cache before navigating here with the new slug.
function OrgLayout() {
  const { org } = Route.useParams();
  return (
    <AppShell org={org}>
      <Outlet />
    </AppShell>
  );
}

export const Route = createFileRoute("/$org")({
  component: OrgLayout,
});
