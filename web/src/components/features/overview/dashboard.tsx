import { Link } from "@tanstack/react-router";
import { ChevronDown, FolderPlus, KeyRound, Plus, ScrollText, UserPlus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useRecentActivity } from "@/components/features/audit/hooks";
import { NoProjects } from "@/components/features/empty/no-projects";
import { QueryError } from "@/components/features/empty/query-error";
import { CreateProjectDialog } from "@/components/features/org/create-project-dialog";
import { QuotaBar } from "@/components/features/org/quota-bar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionCard, SMALL_CONTROL } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Timeline, type TimelineItem } from "@/components/ui/timeline";
import { useApps, useProjects } from "@/hooks/orgs";
import type { OrgRole } from "@/lib/types";

import { AppsTable } from "./apps-table";

const OVERVIEW_APPS = 10;
const OVERVIEW_ACTIVITY = 5;

/** An audit action in words: "app.create" reads "App create". */
export function actionWords(action: string): string {
  const words = action.replace(/[._]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function QuickActions({ org, isAdmin, onNewProject }: { org: string; isAdmin: boolean; onNewProject: () => void }) {
  const { t } = useTranslation("overview");
  return (
    <section aria-label={t("quick.label")} className="flex flex-wrap items-center gap-2">
      <Button asChild>
        <Link to="/$org/apps/new" params={{ org }}>
          <Plus aria-hidden="true" /> {t("quick.newApp")}
        </Link>
      </Button>
      {isAdmin ? (
        <Button variant="secondary" onClick={onNewProject}>
          <FolderPlus aria-hidden="true" /> {t("quick.newProject")}
        </Button>
      ) : null}
      <Button asChild variant="secondary">
        <Link to="/$org/settings/members" params={{ org }}>
          <UserPlus aria-hidden="true" /> {t("quick.inviteMember")}
        </Link>
      </Button>
      <Button asChild variant="secondary">
        <Link to="/$org/settings/tokens" params={{ org }}>
          <KeyRound aria-hidden="true" /> {t("quick.createToken")}
        </Link>
      </Button>
    </section>
  );
}

function AppsCard({ org }: { org: string }) {
  const { t } = useTranslation(["overview", "common"]);
  const apps = useApps(org);
  const projects = useProjects(org);
  const [project, setProject] = useState("*");
  const list = (apps.data ?? []).filter((a) => project === "*" || a.project === project);
  const projectName = projects.data?.find((p) => p.slug === project)?.name ?? project;

  if (projects.isSuccess && projects.data.length === 0) return <NoProjects org={org} />;

  return (
    <SectionCard
      title={t("apps.title")}
      actions={
        <>
          <DropdownMenu>
            <DropdownMenuTrigger className={SMALL_CONTROL} aria-label={t("apps.filter")}>
              {project === "*" ? t("apps.allProjects") : projectName}
              <ChevronDown aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t("apps.projectLabel")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={project} onValueChange={setProject}>
                <DropdownMenuRadioItem value="*">{t("apps.allProjects")}</DropdownMenuRadioItem>
                {(projects.data ?? []).map((p) => (
                  <DropdownMenuRadioItem key={p.slug} value={p.slug}>
                    {p.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Link to="/$org/apps" params={{ org }} className={SMALL_CONTROL}>
            {t("common:viewAll")}
          </Link>
        </>
      }
    >
      {apps.isError ? (
        <QueryError error={apps.error} onRetry={() => void apps.refetch()} notFoundTitle={t("projects.notFound")} />
      ) : (
        <AppsTable
          org={org}
          apps={list.slice(0, OVERVIEW_APPS)}
          projects={projects.data}
          loading={apps.isPending}
          empty={<EmptyState bare entity="apps" title={t("apps.emptyTitle")} description={t("apps.emptyDescription")} />}
          {...(list.length > OVERVIEW_APPS ? { count: t("appsTable.countOf", { shown: OVERVIEW_APPS, count: list.length }) } : {})}
        />
      )}
    </SectionCard>
  );
}

function ActivityCard({ org, canSee }: { org: string; canSee: boolean }) {
  const { t } = useTranslation(["overview", "common"]);
  const activity = useRecentActivity(org, canSee, OVERVIEW_ACTIVITY);
  const items: TimelineItem[] = (activity.data ?? []).map((e) => ({
    id: e.id,
    icon: ScrollText,
    title: (
      <>
        {actionWords(e.action)} <span className="break-all text-[13px] text-muted">{e.target}</span>
      </>
    ),
    actor: e.actor.name ?? e.actor.email ?? t("activity.system"),
    at: e.at,
  }));
  return (
    <SectionCard
      className="h-full"
      title={t("activity.title")}
      actions={
        canSee ? (
          <Link to="/$org/settings/audit" params={{ org }} className={SMALL_CONTROL}>
            {t("common:viewAll")}
          </Link>
        ) : null
      }
    >
      {!canSee ? (
        <EmptyState variant="permission" title={t("activity.adminsOnly")} />
      ) : activity.isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
        </div>
      ) : activity.isError ? (
        <EmptyState variant="error" title={t("activity.error")} onRetry={() => void activity.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState bare entity="audit" icon={ScrollText} title={t("activity.emptyTitle")} description={t("activity.emptyDescription")} />
      ) : (
        <Timeline items={items} />
      )}
    </SectionCard>
  );
}

// Dashboard is the org overview: one row of quick actions, the apps table, then activity and quota.
export function Dashboard({ org, role }: { org: string; role: OrgRole | null | undefined }) {
  const [createOpen, setCreateOpen] = useState(false);
  const isAdmin = role === "owner" || role === "admin";
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <QuickActions org={org} isAdmin={isAdmin} onNewProject={() => setCreateOpen(true)} />
      <AppsCard org={org} />
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <ActivityCard org={org} canSee={isAdmin} />
        <QuotaBar org={org} />
      </div>
      {isAdmin ? <CreateProjectDialog org={org} open={createOpen} onOpenChange={setCreateOpen} /> : null}
    </div>
  );
}
