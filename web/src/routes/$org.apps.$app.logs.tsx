import { createFileRoute } from "@tanstack/react-router";

import { LogsView } from "@/components/features/logs/logs-view";

export const Route = createFileRoute("/$org/apps/$app/logs")({
  staticData: { fullBleed: true },
  component: AppLogsPage,
});

function AppLogsPage() {
  const { org, app } = Route.useParams();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 md:p-6">
      <LogsView org={org} app={app} />
    </div>
  );
}
