import { createFileRoute } from "@tanstack/react-router";

import { LogsView } from "@/components/features/logs/logs-view";

export const Route = createFileRoute("/$org/apps/$app/logs")({
  component: AppLogsPage,
});

function AppLogsPage() {
  const { org, app } = Route.useParams();
  return <LogsView org={org} app={app} />;
}
