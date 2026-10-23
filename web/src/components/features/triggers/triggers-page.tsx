import { useAppView } from "@/components/features/app-header/hooks";
import { QueryError } from "@/components/features/empty/query-error";
import { Skeleton } from "@/components/ui/skeleton";

import { DlqCard } from "./dlq-card";
import { HttpRouteCard } from "./http-route-card";
import { QueueCard } from "./queue-card";
import { SchedulesCard } from "./schedules-card";

// TriggersPage groups everything that starts the app: HTTP access, schedules, the queue (test
// enqueue) and the dead-letter queue.
export function TriggersPage({ org, app }: { org: string; app: string }) {
  const view = useAppView(org, app);

  if (view.isError) {
    return <QueryError error={view.error} onRetry={() => void view.refetch()} notFoundTitle="App not found" />;
  }
  if (view.isPending) return <Skeleton className="h-40 w-full" />;

  return (
    <div className="flex flex-col gap-10">
      <HttpRouteCard key={view.data.etag} org={org} app={app} view={view.data} />
      <SchedulesCard org={org} app={app} />
      <QueueCard org={org} app={app} />
      <DlqCard org={org} app={app} />
    </div>
  );
}
