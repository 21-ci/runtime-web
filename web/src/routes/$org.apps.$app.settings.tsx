import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Download, Settings } from "lucide-react";

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
import { QueryError } from "@/components/features/empty/query-error";
import { PageBody } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, SectionLabel } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyButton } from "@/components/ui/url-bar";
import { useCan } from "@/hooks/authz";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/$org/apps/$app/settings")({
  component: AppSettingsPage,
});

// Settings are grouped into sections, one shown at a time, so the page stays short and each block
// keeps its own save. Each section saves its own block with the etag it was loaded with (If-Match),
// so a stale save is refused rather than overwriting. Write controls are shown only to roles that
// hold the action (viewers see a read-only page). Danger zone appears only for roles that can delete.
type SectionId = "general" | "access" | "limits" | "advanced" | "danger";

function AppSettingsPage() {
  const { org, app } = Route.useParams();
  const navigate = useNavigate();
  const detail = useAppDetail(org, app);
  const can = useCan(org, detail.data?.project);
  const [section, setSection] = useState<SectionId>("general");

  if (detail.isError) {
    return (
      <PageBody>
        <QueryError
          error={detail.error}
          onRetry={() => void detail.refetch()}
          notFoundTitle="App not found"
          notFoundDescription="It may have been deleted or you lack access."
        />
      </PageBody>
    );
  }
  if (detail.isPending) {
    return (
      <PageBody>
        <Skeleton className="h-64 w-full" />
      </PageBody>
    );
  }
  const a = detail.data;
  if (!a) {
    return (
      <PageBody>
        <EmptyState title="App not found" />
      </PageBody>
    );
  }

  const canDelete = can("app.delete") === true;
  const sections: { id: SectionId; label: string }[] = [
    { id: "general", label: "General" },
    { id: "access", label: "Access" },
    { id: "limits", label: "Limits" },
    { id: "advanced", label: "Advanced" },
    ...(canDelete ? [{ id: "danger" as const, label: "Danger zone" }] : []),
  ];

  return (
    <PageBody className="gap-6">
      <PageHeader
        icon={Settings}
        entity="settings"
        title="Settings"
        description={`${a.name ?? a.slug} · ${a.environment}`}
        actions={<StatusPill status={a.status} />}
      />
      <div className="flex flex-col gap-6 md:flex-row md:gap-10">
        <nav aria-label="Settings sections" className="md:sticky md:top-16 md:w-44 md:shrink-0 md:self-start">
          <ul className="flex gap-1 overflow-x-auto md:flex-col [scrollbar-width:none]">
            {sections.map((s) => {
              const current = s.id === section;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-current={current ? "page" : undefined}
                    onClick={() => setSection(s.id)}
                    className={cn(
                      "flex h-8 w-full items-center whitespace-nowrap rounded-md px-2.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus",
                      current
                        ? "bg-active font-medium text-text"
                        : s.id === "danger"
                          ? "text-danger-text hover:bg-hover"
                          : "text-muted hover:bg-hover hover:text-text",
                    )}
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
                <SectionLabel>General</SectionLabel>
                <ScalingSection org={org} app={a} />
                <IngressSection org={org} app={a} />
                <EgressSection org={org} app={a} />
              </>
            ) : null}
            {section === "access" ? (
              <>
                <SectionLabel>Access</SectionLabel>
                <AccessSection org={org} app={a} />
                <CallersSection org={org} app={a} />
              </>
            ) : null}
            {section === "limits" ? (
              <>
                <SectionLabel>Limits</SectionLabel>
                <LimitsSection org={org} app={a} />
              </>
            ) : null}
          </WriteAccess.Provider>
          {section === "advanced" ? (
            <>
              <SectionLabel>Advanced</SectionLabel>
              <dl className="divide-y divide-line rounded-lg border border-line bg-surface shadow-card">
                <AdvancedRow label="Slug" hint="Identifies the app on the runtime and in the API.">
                  <code className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[13px]">{a.slug}</code>
                  <CopyButton text={a.slug} label="Copy slug" />
                </AdvancedRow>
                <AdvancedRow label="Live URL">
                  <code className="truncate rounded-md bg-panel-2 px-1.5 py-0.5 text-[13px]">{a.url}</code>
                  <CopyButton text={a.url} label="Copy URL" />
                </AdvancedRow>
                <AdvancedRow label="Runtime">
                  <span className="text-sm">{a.runtime}{a.profile ? ` · profile ${a.profile}` : ""}</span>
                </AdvancedRow>
                <AdvancedRow label="Env & Secrets" hint="Variables and secrets moved to their own page.">
                  <Button asChild variant="secondary" size="sm">
                    <Link to="/$org/apps/$app/env" params={{ org, app }}>
                      Open Env & Secrets
                    </Link>
                  </Button>
                </AdvancedRow>
                <AdvancedRow label="Domains" hint="Custom host names for this app.">
                  <Button asChild variant="secondary" size="sm">
                    <Link to="/$org/apps/$app/domains" params={{ org, app }}>
                      Open Domains
                    </Link>
                  </Button>
                </AdvancedRow>
                {can("app.data.export") === true ? (
                  <AdvancedRow label="Export data" hint="Download the app's SQLite database.">
                    <Button asChild variant="secondary" size="sm">
                      <a href={`/api/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}/export`} download>
                        <Download aria-hidden="true" /> Download
                      </a>
                    </Button>
                  </AdvancedRow>
                ) : null}
              </dl>
            </>
          ) : null}
          {section === "danger" && canDelete ? (
            <>
              <SectionLabel className="text-danger-text">Danger zone</SectionLabel>
              <DangerZone org={org} app={a} onDeleted={() => void navigate({ to: "/$org", params: { org } })} />
            </>
          ) : null}
        </div>
      </div>
    </PageBody>
  );
}

function AdvancedRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center sm:gap-6">
      <dt className="sm:w-40 sm:shrink-0">
        <span className="block text-sm font-medium">{label}</span>
        {hint ? <span className="block text-[12px] text-muted">{hint}</span> : null}
      </dt>
      <dd className="flex min-w-0 flex-1 items-center gap-1 sm:justify-end">{children}</dd>
    </div>
  );
}
