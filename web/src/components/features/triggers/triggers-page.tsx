import { Clock } from "lucide-react";

import { useAppView } from "@/components/features/app-header/hooks";
import { PageHeader } from "@/components/ui/page-header";
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

const CARD = "block min-w-0 rounded-lg border border-line bg-surface p-5 shadow-card";

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
    <div className="flex flex-col gap-6">
      <PageHeader icon={Clock} entity="triggers" title="Triggers" description="Everything that starts this app: HTTP, schedules and the queue." />
      <fieldset disabled={can("app.update") !== true} className={CARD}>
        <HttpRouteCard key={view.data.etag} org={org} app={app} view={view.data} />
      </fieldset>
      <fieldset disabled={can("app.schedules.write") !== true} className={CARD}>
        <SchedulesCard org={org} app={app} cronAllowed={planAllowsCron(limits.data)} />
      </fieldset>
      <div className={CARD}>
        <OnceSchedulesCard org={org} app={app} />
      </div>
      <fieldset disabled={can("app.queue.write") !== true} className={CARD}>
        <QueueCard org={org} app={app} />
      </fieldset>
      <fieldset disabled={can("app.queue.write") !== true} className={CARD}>
        <DlqCard org={org} app={app} />
      </fieldset>
    </div>
  );
}
