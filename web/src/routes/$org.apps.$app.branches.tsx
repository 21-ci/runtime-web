import { createFileRoute } from "@tanstack/react-router";

import { useAppDetail } from "@/components/features/app-settings/api";
import { BranchesView } from "@/components/features/branches/branches-view";
import { PreviewsCard } from "@/components/features/git/previews";
import { PageBody } from "@/components/layout/app-shell";

export const Route = createFileRoute("/$org/apps/$app/branches")({
  component: AppBranchesPage,
});

function AppBranchesPage() {
  const { org, app } = Route.useParams();
  const detail = useAppDetail(org, app);
  return (
    <PageBody>
      <div className="flex flex-col gap-6">
        <BranchesView org={org} app={app} />
        <PreviewsCard org={org} app={app} project={detail.data?.project} />
      </div>
    </PageBody>
  );
}
