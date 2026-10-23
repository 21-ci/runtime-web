import { createFileRoute } from "@tanstack/react-router";

import { OverviewPage } from "@/components/features/overview/overview-page";

export const Route = createFileRoute("/$org/apps/$app/")({
  component: OverviewRoute,
});

function OverviewRoute() {
  const { org, app } = Route.useParams();
  return <OverviewPage org={org} app={app} />;
}
