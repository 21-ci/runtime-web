import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { LogsView } from "@/components/features/logs/logs-view";
import { parseLogSearch, type LogSearch } from "@/components/features/logs/log-filter";

export const Route = createFileRoute("/$org/apps/$app/logs")({
  staticData: { fullBleed: true },
  validateSearch: (search: Record<string, unknown>): LogSearch => parseLogSearch(search),
  component: AppLogsPage,
});

function AppLogsPage() {
  const { org, app } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 md:p-6">
      <LogsView org={org} app={app} search={search} onSearchChange={(next) => void navigate({ search: next, replace: true })} />
    </div>
  );
}
