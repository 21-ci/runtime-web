import { useEffect } from "react";
import { createFileRoute, Outlet } from "@tanstack/react-router";

import { NotFoundContent, NotFoundPage } from "@/components/features/empty/not-found-page";
import { AppShell } from "@/components/layout/app-shell";
import { writeLastOrg } from "@/components/layout/last-org";
import { useProjects } from "@/hooks/orgs";
import { ApiError } from "@/lib/api";

// Every org-scoped page renders inside the shell. Org changes come from the switcher, which clears
// the query cache before navigating here with the new slug. An org the caller cannot see answers
// 404 on its projects, and then there is no org to frame the page with.
function OrgLayout() {
  const { org } = Route.useParams();
  const projects = useProjects(org);
  const missing = projects.error instanceof ApiError && projects.error.status === 404;
  // Instance-admin pages keep this org in the shell (switcher, projects, ⌘K).
  useEffect(() => {
    if (!missing) writeLastOrg(org);
  }, [org, missing]);
  if (missing) return <NotFoundPage />;
  return (
    <AppShell org={org}>
      <Outlet />
    </AppShell>
  );
}

function OrgNotFound() {
  const { org } = Route.useParams();
  return <NotFoundContent to="/$org" params={{ org }} />;
}

export const Route = createFileRoute("/$org")({
  component: OrgLayout,
  notFoundComponent: OrgNotFound,
});
