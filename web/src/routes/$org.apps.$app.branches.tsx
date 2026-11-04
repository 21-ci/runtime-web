import { createFileRoute } from "@tanstack/react-router";

import { PageBody } from "@/components/layout/app-shell";

import { BranchesView } from "@/components/features/branches/branches-view";

export const Route = createFileRoute("/$org/apps/$app/branches")({
  component: AppBranchesPage,
});

function AppBranchesPage() {
  const { org, app } = Route.useParams();
  return (
    <PageBody>
      <BranchesView org={org} app={app} />
    </PageBody>
  );
}
