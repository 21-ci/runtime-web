import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Gauge, GitBranch, Globe, Settings, Shield, SlidersHorizontal, TriangleAlert, Wrench, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AccessSection } from "@/components/features/app-settings/access";
import { BundleSection } from "@/components/features/app-settings/bundle";
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
import { GitSettings } from "@/components/features/git/git-settings";
import { DataEventsCard } from "@/components/features/triggers/data-events-card";
import { QueryError } from "@/components/features/empty/query-error";
import { PageBody } from "@/components/layout/app-shell";
import { SettingsRow as AdvancedRow, SettingsRows } from "@/components/layout/settings-section";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyButton } from "@/components/ui/url-bar";
import { useCan } from "@/hooks/authz";
import { cn } from "@/lib/utils";

const SECTION_IDS = ["general", "access", "limits", "git", "integrations", "advanced", "danger"] as const;
type SectionId = (typeof SECTION_IDS)[number];

export const Route = createFileRoute("/$org/apps/$app/settings")({
  validateSearch: (s: Record<string, unknown>): { section?: SectionId } =>
    SECTION_IDS.includes(s.section as SectionId) ? { section: s.section as SectionId } : {},
  component: AppSettingsPage,
});

// Settings are grouped into sections, one shown at a time, so the page stays short and each block
// keeps its own save. Each section saves its own block with the etag it was loaded with (If-Match),
// so a stale save is refused rather than overwriting. Write controls are shown only to roles that
// hold the action (viewers see a read-only page). Danger zone appears only for roles that can delete.
type SectionDef = {
  id: SectionId;
  labelKey: `nav.${SectionId}`;
  hintKey: `nav.${SectionId}Hint`;
  icon: LucideIcon;
};

function AppSettingsPage() {
  const { org, app } = Route.useParams();
  const navigate = useNavigate();
  const { t } = useTranslation(["app-settings", "common"]);
  const detail = useAppDetail(org, app);
  const can = useCan(org, detail.data?.project);
  const search = Route.useSearch();
  // In the URL, so a link can open a section and a reload stays on it.
  const section: SectionId = search.section ?? "general";
  const setSection = (id: SectionId) => void navigate({ to: ".", search: id === "general" ? {} : { section: id }, replace: true });

  if (detail.isError) {
    return (
      <PageBody>
        <QueryError
          error={detail.error}
          onRetry={() => void detail.refetch()}
          notFoundTitle={t("page.notFound")}
          notFoundDescription={t("page.notFoundDescription")}
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
        <EmptyState title={t("page.notFound")} />
      </PageBody>
    );
  }

  const canDelete = can("app.delete") === true;
  const sections: SectionDef[] = [
    { id: "general", labelKey: "nav.general", hintKey: "nav.generalHint", icon: SlidersHorizontal },
    { id: "access", labelKey: "nav.access", hintKey: "nav.accessHint", icon: Shield },
    { id: "limits", labelKey: "nav.limits", hintKey: "nav.limitsHint", icon: Gauge },
    { id: "git", labelKey: "nav.git", hintKey: "nav.gitHint", icon: GitBranch },
    { id: "integrations", labelKey: "nav.integrations", hintKey: "nav.integrationsHint", icon: Globe },
    { id: "advanced", labelKey: "nav.advanced", hintKey: "nav.advancedHint", icon: Wrench },
    ...(canDelete ? [{ id: "danger" as const, labelKey: "nav.danger" as const, hintKey: "nav.dangerHint" as const, icon: TriangleAlert }] : []),
  ];

  return (
    <PageBody className="gap-6">
      <PageHeader
        icon={Settings}
        entity="settings"
        title={t("page.title")}
        description={t("page.description", { name: a.name ?? a.slug, environment: a.environment })}
        actions={<StatusPill status={a.status} />}
      />
      <div className="flex flex-col gap-6 md:flex-row md:gap-10">
        <nav aria-label={t("nav.label")} className="md:sticky md:top-16 md:w-48 md:shrink-0 md:self-start">
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
                      "flex h-8 w-full items-center gap-2 whitespace-nowrap rounded-md px-2.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus",
                      current
                        ? "bg-active font-medium text-text"
                        : s.id === "danger"
                          ? "text-danger-text hover:bg-hover"
                          : "text-muted hover:bg-hover hover:text-text",
                    )}
                  >
                    <s.icon className="size-4 shrink-0" aria-hidden="true" />
                    {t(s.labelKey)}
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
                <SectionTitle section={sections.find((s) => s.id === "general")!} />
                <ScalingSection org={org} app={a} />
                <IngressSection org={org} app={a} />
                <EgressSection org={org} app={a} />
              </>
            ) : null}
            {section === "access" ? (
              <>
                <SectionTitle section={sections.find((s) => s.id === "access")!} />
                <AccessSection org={org} app={a} />
                <CallersSection org={org} app={a} />
              </>
            ) : null}
            {section === "limits" ? (
              <>
                <SectionTitle section={sections.find((s) => s.id === "limits")!} />
                <LimitsSection org={org} app={a} />
              </>
            ) : null}
          </WriteAccess.Provider>
          {section === "git" ? (
            <>
              <SectionTitle section={sections.find((s) => s.id === "git")!} />
              <GitSettings org={org} app={app} />
            </>
          ) : null}
          {section === "integrations" ? (
            <>
              <SectionTitle section={sections.find((s) => s.id === "integrations")!} />
              <SectionCard title={t("integrations.domains")} description={t("integrations.domainsHint")}>
                <DomainsPanel org={org} app={app} canWrite={can("domains.manage") === true} />
              </SectionCard>
              <DataEventsCard org={org} app={app} />
            </>
          ) : null}
          {section === "advanced" ? (
            <>
              <SectionTitle section={sections.find((s) => s.id === "advanced")!} />
              <SettingsRows>
                <AdvancedRow label={t("advanced.slug")} hint={t("advanced.slugHint")}>
                  <code className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[13px]">{a.slug}</code>
                  <CopyButton text={a.slug} label={t("advanced.copySlug")} />
                </AdvancedRow>
                <AdvancedRow label={t("advanced.liveUrl")}>
                  <code className="truncate rounded-md bg-panel-2 px-1.5 py-0.5 text-[13px]">{a.url}</code>
                  <CopyButton text={a.url} label={t("common:copyUrl")} />
                </AdvancedRow>
                <AdvancedRow label={t("advanced.runtime")}>
                  <span className="text-sm">
                    {a.profile ? t("advanced.runtimeProfile", { runtime: a.runtime, profile: a.profile }) : a.runtime}
                  </span>
                </AdvancedRow>
                <AdvancedRow label={t("advanced.envSecrets")} hint={t("advanced.envSecretsHint")}>
                  <Button asChild variant="secondary" size="sm">
                    <Link to="/$org/apps/$app/env" params={{ org, app }}>
                      {t("advanced.openEnvSecrets")}
                    </Link>
                  </Button>
                </AdvancedRow>
              </SettingsRows>
              {can("app.data.export") === true ? <BundleSection org={org} app={app} project={a.project} environment={a.environment} /> : null}
            </>
          ) : null}
          {section === "danger" && canDelete ? (
            <>
              <SectionTitle section={sections.find((s) => s.id === "danger")!} danger />
              <DangerZone org={org} app={a} onDeleted={() => void navigate({ to: "/$org", params: { org } })} />
            </>
          ) : null}
        </div>
      </div>
    </PageBody>
  );
}

function SectionTitle({ section, danger = false }: { section: SectionDef; danger?: boolean }) {
  const { t } = useTranslation("app-settings");
  return (
    <div>
      <h2 className={cn("text-[15px] font-semibold", danger ? "text-danger-text" : "text-text")}>{t(section.labelKey)}</h2>
      <p className="text-[13px] text-muted">{t(section.hintKey)}</p>
    </div>
  );
}
