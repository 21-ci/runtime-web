import { createFileRoute } from "@tanstack/react-router";

import { PageBody } from "@/components/layout/app-shell";

import { VersionsView } from "@/components/features/versions/versions-view";

export const Route = createFileRoute("/$org/apps/$app/versions")({
  component: AppVersionsPage,
});

function AppVersionsPage() {
  const { org, app } = Route.useParams();
  return (
    <PageBody>
      <VersionsView org={org} app={app} />
    </PageBody>
  );
}
