import { useAppView } from "@/components/features/app-header/hooks";
import { QueryError } from "@/components/features/empty/query-error";
import { Skeleton } from "@/components/ui/skeleton";
import { useCan } from "@/hooks/authz";
import { useLimits } from "@/hooks/orgs";

import { planAllowsCron } from "./cron-allowed";

import { DlqCard } from "./dlq-card";
import { HttpRouteCard } from "./http-route-card";
import { OnceSchedulesCard } from "./once-schedules-card";
import { QueueCard } from "./queue-card";
import { SchedulesCard } from "./schedules-card";

// TriggersPage groups everything that starts the app: HTTP access, schedules, the queue (test
// enqueue) and the dead-letter queue. Each card's controls are disabled for roles without its
// write action (HTTP route: app.update; schedules: app.schedules.write; queue/DLQ: app.queue.write).
export function TriggersPage({ org, app }: { org: string; app: string }) {
  const view = useAppView(org, app);
  const can = useCan(org, view.data?.project);
  const limits = useLimits(org);

  if (view.isError) {
    return <QueryError error={view.error} onRetry={() => void view.refetch()} notFoundTitle="App not found" />;
  }
  // Wait for the plan's trigger kinds so the schedule dialog opens with the right default kind.
  if (view.isPending || limits.isPending) return <Skeleton className="h-40 w-full" />;

  return (
    <div className="flex flex-col gap-10">
      <fieldset disabled={can("app.update") !== true} className="contents">
        <HttpRouteCard key={view.data.etag} org={org} app={app} view={view.data} />
      </fieldset>
      <fieldset disabled={can("app.schedules.write") !== true} className="contents">
        <SchedulesCard org={org} app={app} cronAllowed={planAllowsCron(limits.data)} />
      </fieldset>
      <OnceSchedulesCard org={org} app={app} />
      <fieldset disabled={can("app.queue.write") !== true} className="contents">
        <QueueCard org={org} app={app} />
        <DlqCard org={org} app={app} />
      </fieldset>
    </div>
  );
}
