import { createFileRoute } from "@tanstack/react-router";

import { AnalyticsView } from "@/components/features/analytics/analytics-page";
import { PageBody } from "@/components/layout/app-shell";

export const Route = createFileRoute("/$org/apps/$app/analytics")({
  component: AppAnalyticsPage,
});

function AppAnalyticsPage() {
  const { org, app } = Route.useParams();
  return (
    <PageBody>
      <AnalyticsView org={org} app={app} />
    </PageBody>
  );
}
