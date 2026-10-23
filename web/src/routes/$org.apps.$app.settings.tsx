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
import { WriteAccess } from "@/components/features/app-settings/shared";
import { DomainsPanel } from "@/components/features/domains/domains-panel";
import { EnvEditor } from "@/components/features/env/env-editor";
import { SecretsPanel } from "@/components/features/secrets/secrets-panel";
import { QueryError } from "@/components/features/empty/query-error";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useCan } from "@/hooks/authz";

export const Route = createFileRoute("/$org/apps/$app/settings")({
  component: AppSettingsPage,
});

// AppSettingsPage holds the runtime blocks of one app. Each section saves its own block with the
// etag it was loaded with (If-Match), so a stale save is refused rather than overwriting.
// Write controls are shown only to roles that hold the action (viewers see a read-only page).
function AppSettingsPage() {
  const { org, app } = Route.useParams();
  const navigate = useNavigate();
  const detail = useAppDetail(org, app);
  const can = useCan(org, detail.data?.project);

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
      <WriteAccess.Provider value={can("app.update") === true}>
        <AccessSection org={org} app={a} />
        <ScalingSection org={org} app={a} />
        <IngressSection org={org} app={a} />
        <EgressSection org={org} app={a} />
        <CallersSection org={org} app={a} />
        <LimitsSection org={org} app={a} />
      </WriteAccess.Provider>
      <section className="rounded-[6px] border border-line bg-surface p-4">
        <EnvEditor org={org} app={app} canWrite={can("app.env.write") === true} />
      </section>
      <section className="rounded-[6px] border border-line bg-surface p-4">
        <SecretsPanel org={org} app={app} canWrite={can("app.secrets.write") === true} />
      </section>
      <section className="rounded-[6px] border border-line bg-surface p-4">
        <DomainsPanel org={org} app={app} canWrite={can("domains.manage") === true} />
      </section>
      {can("app.delete") === true ? (
        <DangerZone org={org} app={a} onDeleted={() => void navigate({ to: "/$org", params: { org } })} />
      ) : null}
    </div>
  );
}
