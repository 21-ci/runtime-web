import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { AccessSection } from "@/components/features/app-settings/access";
import { CallersSection } from "@/components/features/app-settings/callers";
import { DangerZone } from "@/components/features/app-settings/danger-zone";
import { EgressSection } from "@/components/features/app-settings/egress";
import { IngressSection } from "@/components/features/app-settings/ingress";
import { LimitsSection } from "@/components/features/app-settings/limits";
import { ScalingSection } from "@/components/features/app-settings/scaling";
import { StatusPill } from "@/components/features/app-settings/status-pill";
import { useAppDetail } from "@/components/features/app-settings/api";
import { QueryError } from "@/components/features/empty/query-error";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/$org/apps/$app/settings")({
  component: AppSettingsPage,
});

// AppSettingsPage holds the runtime blocks of one app. Each section saves its own block with the
// etag it was loaded with (If-Match), so a stale save is refused rather than overwriting.
function AppSettingsPage() {
  const { org, app } = Route.useParams();
  const navigate = useNavigate();
  const detail = useAppDetail(org, app);

  if (detail.isError) {
    return (
      <QueryError
        error={detail.error}
        onRetry={() => void detail.refetch()}
        notFoundTitle="App not found"
        notFoundDescription="It may have been deleted or you lack access."
      />
    );
  }
  if (detail.isPending) return <Skeleton className="h-64 w-full" />;
  const a = detail.data;
  if (!a) return <EmptyState title="App not found" />;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">{a.name ?? a.slug} settings</h1>
        <StatusPill status={a.status} />
      </header>
      <AccessSection org={org} app={a} />
      <ScalingSection org={org} app={a} />
      <IngressSection org={org} app={a} />
      <EgressSection org={org} app={a} />
      <CallersSection org={org} app={a} />
      <LimitsSection org={org} app={a} />
      <DangerZone org={org} app={a} onDeleted={() => void navigate({ to: "/$org", params: { org } })} />
    </div>
  );
}
