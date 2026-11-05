import { createFileRoute } from "@tanstack/react-router";

import { PageBody } from "@/components/layout/app-shell";

import { BranchesView } from "@/components/features/branches/branches-view";
import { GitSettings } from "@/components/features/git/git-settings";

export const Route = createFileRoute("/$org/apps/$app/branches")({
  component: AppBranchesPage,
});

function AppBranchesPage() {
  const { org, app } = Route.useParams();
  return (
    <PageBody>
      <div className="flex flex-col gap-6">
        <BranchesView org={org} app={app} />
        <GitSettings org={org} app={app} />
      </div>
    </PageBody>
  );
}
