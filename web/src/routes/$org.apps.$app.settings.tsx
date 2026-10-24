import { useState } from "react";
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

// Settings are grouped into sections, one shown at a time, so the page stays short and each block
// keeps its own save. Each section saves its own block with the etag it was loaded with (If-Match),
// so a stale save is refused rather than overwriting. Write controls are shown only to roles that
// hold the action (viewers see a read-only page). Danger zone appears only for roles that can delete.
type SectionId = "general" | "access" | "domains" | "limits" | "danger";

function AppSettingsPage() {
  const { org, app } = Route.useParams();
  const navigate = useNavigate();
  const detail = useAppDetail(org, app);
  const can = useCan(org, detail.data?.project);
  const [section, setSection] = useState<SectionId>("general");

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

  const canDelete = can("app.delete") === true;
  const sections: { id: SectionId; label: string }[] = [
    { id: "general", label: "General" },
    { id: "access", label: "Access" },
    { id: "domains", label: "Domains" },
    { id: "limits", label: "Limits" },
    ...(canDelete ? [{ id: "danger" as const, label: "Danger zone" }] : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{a.name ?? a.slug} settings</h1>
        <StatusPill status={a.status} />
      </header>
      <div className="flex flex-col gap-6 md:flex-row md:gap-8">
        <nav aria-label="Settings sections" className="md:w-44 md:shrink-0">
          <ul className="flex gap-1 overflow-x-auto md:flex-col [scrollbar-width:none]">
            {sections.map((s) => {
              const current = s.id === section;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-current={current ? "page" : undefined}
                    onClick={() => setSection(s.id)}
                    className={
                      "flex h-8 w-full items-center whitespace-nowrap rounded-md px-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus " +
                      (current
                        ? "bg-surface font-medium text-text shadow-card"
                        : s.id === "danger"
                          ? "text-danger-text hover:bg-hover"
                          : "text-muted hover:bg-hover hover:text-text")
                    }
                  >
                    {s.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <WriteAccess.Provider value={can("app.update") === true}>
            {section === "general" ? (
              <>
                <ScalingSection org={org} app={a} />
                <IngressSection org={org} app={a} />
                <EgressSection org={org} app={a} />
                <section className="rounded-md border border-line bg-surface p-4">
                  <EnvEditor org={org} app={app} canWrite={can("app.env.write") === true} />
                </section>
                <section className="rounded-md border border-line bg-surface p-4">
                  <SecretsPanel org={org} app={app} canWrite={can("app.secrets.write") === true} />
                </section>
              </>
            ) : null}
            {section === "access" ? (
              <>
                <AccessSection org={org} app={a} />
                <CallersSection org={org} app={a} />
              </>
            ) : null}
          </WriteAccess.Provider>
          {section === "domains" ? (
            <section className="rounded-md border border-line bg-surface p-4">
              <DomainsPanel org={org} app={app} canWrite={can("domains.manage") === true} />
            </section>
          ) : null}
          {section === "limits" ? (
            <WriteAccess.Provider value={can("app.update") === true}>
              <LimitsSection org={org} app={a} />
            </WriteAccess.Provider>
          ) : null}
          {section === "danger" && canDelete ? (
            <DangerZone org={org} app={a} onDeleted={() => void navigate({ to: "/$org", params: { org } })} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
