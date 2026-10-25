import { createFileRoute } from "@tanstack/react-router";

import { PageBody } from "@/components/layout/app-shell";

import { OverviewPage } from "@/components/features/overview/overview-page";

export const Route = createFileRoute("/$org/apps/$app/")({
  component: OverviewRoute,
});

function OverviewRoute() {
  const { org, app } = Route.useParams();
  return (
    <PageBody>
      <OverviewPage org={org} app={app} />
    </PageBody>
  );
}
