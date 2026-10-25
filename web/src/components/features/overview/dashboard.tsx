import { Link } from "@tanstack/react-router";
import {
  Boxes,
  ChevronDown,
  Eye,
  FolderOpen,
  ChevronRight,
  FolderPlus,
  Globe,
  KeyRound,
  MoreVertical,
  Plus,
  ScrollText,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useRecentActivity } from "@/components/features/audit/hooks";
import { NoProjects } from "@/components/features/empty/no-projects";
import { QueryError } from "@/components/features/empty/query-error";
import { useMembers } from "@/components/features/members/hooks";
import { ROLE_KEY } from "@/components/features/members/roles";
import { CreateProjectDialog } from "@/components/features/org/create-project-dialog";
import { OrgAvatar } from "@/components/layout/org-switcher";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { IconTile, LetterTile, hueFor, type Entity, type Hue } from "@/components/ui/icon-tile";
import { SectionCard, SMALL_CONTROL, SMALL_ICON } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useApps, useProjects } from "@/hooks/orgs";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { OrgRole } from "@/lib/types";

const PROJECT_HUES: Hue[] = ["green", "blue", "pink", "yellow", "purple", "teal", "orange"];

const BUILD_VARIANT: Record<string, "success" | "danger" | "warning" | "default"> = {
  ready: "success",
  failed: "danger",
  building: "warning",
  pending: "warning",
};

const BUILD_KEY = {
  ready: "build.ready",
  failed: "build.failed",
  building: "build.building",
  pending: "build.pending",
} as const;

function QuickAction({
  icon,
  entity,
  title,
  subtitle,
  to,
  params,
  onClick,
}: {
  icon: LucideIcon;
  entity: Entity;
  title: string;
  subtitle: string;
  to?: string;
  params?: Record<string, string>;
  onClick?: () => void;
}) {
  // Every card is a column (tile, title, two-line description) that fills its grid cell, so a row of
  // cards shares one height and text wraps or clamps inside the card instead of spilling out.
  const cls =
    "flex h-full w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg border border-line bg-surface p-3 text-left shadow-card outline-none transition-[background-color,border-color,box-shadow] duration-[140ms] hover:border-line-strong hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus lg:flex-col lg:items-start lg:gap-2.5 lg:p-3.5";
  const body = (
    <>
      <IconTile icon={icon} entity={entity} size="md" solid />
      <span className="flex w-full min-w-0 flex-col gap-0.5">
        <span className="line-clamp-2 break-words text-sm font-medium text-text" title={title}>
          {title}
        </span>
        <span className="line-clamp-2 break-words text-[12px] leading-snug text-muted" title={subtitle}>
          {subtitle}
        </span>
      </span>
    </>
  );
  return (
    <li className="flex min-w-0">
      {to ? (
        <Link to={to} params={params} className={cls}>
          {body}
        </Link>
      ) : (
        <button type="button" onClick={onClick} className={cls}>
          {body}
        </button>
      )}
    </li>
  );
}

function CardMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={label} className={SMALL_ICON}>
        <MoreVertical aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function SkeletonGrid({ n = 4, h = "h-20" }: { n?: number; h?: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2" aria-busy="true">
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} className={h} />
      ))}
    </div>
  );
}

function ProjectsCard({ org }: { org: string }) {
  const { t } = useTranslation(["overview", "common"]);
  const projects = useProjects(org);
  const apps = useApps(org);
  const list = projects.data ?? [];
  return (
    <section aria-labelledby="projects-heading" className="flex min-w-0 flex-col">
      {projects.isError ? (
        <>
          <h2 id="projects-heading" className="mb-3 text-[15px] font-semibold">
            {t("projects.title")}
          </h2>
          <QueryError error={projects.error} onRetry={() => void projects.refetch()} notFoundTitle={t("projects.notFound")} />
        </>
      ) : projects.isPending ? (
        <>
          <h2 id="projects-heading" className="mb-3 text-[15px] font-semibold">
            {t("projects.title")}
          </h2>
          <SkeletonGrid n={2} h="h-12" />
        </>
      ) : list.length === 0 ? (
        <>
          <h2 id="projects-heading" className="mb-3 text-[15px] font-semibold">
            {t("projects.title")}
          </h2>
          <NoProjects org={org} />
        </>
      ) : (
        <div className="flex min-w-0 flex-col rounded-lg border border-line bg-surface shadow-card">
          <header className="flex items-center gap-2 px-5 pb-3 pt-4">
            <h2 id="projects-heading" className="text-[15px] font-semibold">
              {t("projects.title")}
            </h2>
            <span className="text-[12px] text-muted">{list.length}</span>
          </header>
          <ul className="divide-y divide-line border-t border-line">
            {list.map((p, i) => {
              const count = (apps.data ?? []).filter((a) => a.project === p.slug).length;
              return (
                <li key={p.slug} className="min-w-0">
                  <Link
                    to="/$org/projects/$p"
                    params={{ org, p: p.slug }}
                    className="flex h-12 min-w-0 items-center gap-3 px-5 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                  >
                    <IconTile icon={FolderOpen} hue={PROJECT_HUES[i % PROJECT_HUES.length]} size="sm" solid />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text" title={p.name}>
                      {p.name}
                    </span>
                    <span className="hidden min-w-0 items-center gap-1 sm:flex">
                      {p.environments.map((e) => (
                        <Badge key={e} variant="outline">
                          {e}
                        </Badge>
                      ))}
                    </span>
                    <span className="shrink-0 whitespace-nowrap text-right text-[12px] tabular-nums text-muted">
                      {apps.data ? t("projects.appCount", { count }) : ""}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted/60" aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

function AppsCard({ org }: { org: string }) {
  const { t } = useTranslation(["overview", "common"]);
  const apps = useApps(org);
  const projects = useProjects(org);
  const [project, setProject] = useState("*");
  const list = (apps.data ?? []).filter((a) => project === "*" || a.project === project);
  const projectName = (slug: string) => projects.data?.find((p) => p.slug === slug)?.name ?? slug;

  return (
    <SectionCard
      title={t("apps.title")}
      actions={
        <>
          <DropdownMenu>
            <DropdownMenuTrigger className={SMALL_CONTROL} aria-label={t("apps.filter")}>
              {project === "*" ? t("apps.allProjects") : projectName(project)}
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
          <CardMenu label={t("apps.menu")}>
            <DropdownMenuItem asChild>
              <Link to="/$org/apps/new" params={{ org }}>
                <Plus aria-hidden="true" /> {t("apps.new")}
              </Link>
            </DropdownMenuItem>
          </CardMenu>
        </>
      }
    >
      {apps.isPending ? (
        <SkeletonGrid />
      ) : list.length === 0 ? (
        <EmptyState bare entity="apps" icon={Boxes} title={t("apps.emptyTitle")} description={t("apps.emptyDescription")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((a) => (
            <li key={`${a.project}/${a.slug}`} className="min-w-0">
              <Link
                to="/$org/apps/$app"
                params={{ org, app: a.slug }}
                className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5 outline-none transition-[border-color,background-color] duration-[140ms] hover:border-line-strong hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
              >
                <LetterTile label={a.name ?? a.slug} hue={hueFor(a.slug)} size="md" solid />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text" title={a.name ?? a.slug}>
                    {a.name ?? a.slug}
                  </span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
                    <Badge variant={BUILD_VARIANT[a.status.build_state] ?? "default"} dot className="h-4 shrink-0 px-1 text-[11px]">
                      {BUILD_KEY[a.status.build_state as keyof typeof BUILD_KEY]
                        ? t(BUILD_KEY[a.status.build_state as keyof typeof BUILD_KEY])
                        : a.status.build_state}
                    </Badge>
                    <span className="min-w-0 truncate" title={`${projectName(a.project)} / ${a.environment}`}>
                      {projectName(a.project)} / {a.environment}
                    </span>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function ActivityCard({ org, canSee }: { org: string; canSee: boolean }) {
  const { t } = useTranslation(["overview", "common"]);
  const activity = useRecentActivity(org, canSee);
  const items = activity.data ?? [];
  return (
    <SectionCard
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
        <EmptyState bare entity="audit" icon={ScrollText} title={t("activity.adminsOnly")} description={t("activity.adminsHint")} />
      ) : activity.isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : activity.isError ? (
        <EmptyState bare entity="audit" icon={ScrollText} title={t("activity.error")} />
      ) : items.length === 0 ? (
        <EmptyState bare entity="audit" icon={ScrollText} title={t("activity.emptyTitle")} description={t("activity.emptyDescription")} />
      ) : (
        <ol className="relative flex flex-col">
          {items.map((e, i) => {
            const who = e.actor.name ?? e.actor.email ?? t("activity.system");
            return (
              <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
                {i < items.length - 1 ? <span aria-hidden="true" className="absolute bottom-0 left-3 top-7 w-px bg-line" /> : null}
                <OrgAvatar name={who} className="size-6 rounded-full text-[11px]" />
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-text">
                    <span className="min-w-0 truncate font-medium" title={who}>
                      {who}
                    </span>
                    <code className="min-w-0 max-w-full truncate rounded-md bg-panel-2 px-1.5 py-0.5 text-[12px]" title={e.action}>
                      {e.action}
                    </code>
                  </p>
                  <p className="mt-0.5 truncate text-[12px] text-muted" title={e.target}>
                    {e.target} ·{" "}
                    <time dateTime={new Date(e.at).toISOString()} title={formatDateTime(e.at)}>
                      {formatRelative(e.at)}
                    </time>
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </SectionCard>
  );
}

function MembersCard({ org }: { org: string }) {
  const { t } = useTranslation(["overview", "common", "members"]);
  const members = useMembers(org);
  const list = members.data ?? [];
  return (
    <SectionCard
      title={members.data ? t("members.titleCount", { count: list.length }) : t("members.title")}
      actions={
        <CardMenu label={t("members.menu")}>
          <DropdownMenuItem asChild>
            <Link to="/$org/settings/members" params={{ org }}>
              <UserPlus aria-hidden="true" /> {t("members.invite")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to="/$org/settings/members" params={{ org }}>
              <Eye aria-hidden="true" /> {t("members.manage")}
            </Link>
          </DropdownMenuItem>
        </CardMenu>
      }
    >
      {members.isPending ? (
        <SkeletonGrid n={3} h="h-24" />
      ) : members.isError || list.length === 0 ? (
        <EmptyState bare entity="members" title={t("members.empty")} />
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {list.map((m) => {
            const name = m.user.name ?? m.user.email;
            return (
              <li key={m.user.id} className="flex min-w-0 items-center gap-3 py-2 first:pt-0 last:pb-0">
                <OrgAvatar name={name} solid className="size-8 rounded-full text-[13px]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text" title={name}>
                    {name}
                  </span>
                  <span className="block truncate text-[12px] text-muted" title={m.user.email}>
                    {m.user.email}
                  </span>
                </span>
                <Badge>{t(ROLE_KEY[m.role])}</Badge>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

// Dashboard is the org overview: quick actions, then projects, apps, activity and members cards.
export function Dashboard({ org, role }: { org: string; role: OrgRole | null | undefined }) {
  const { t } = useTranslation("overview");
  const apps = useApps(org);
  const [createOpen, setCreateOpen] = useState(false);
  const isAdmin = role === "owner" || role === "admin";
  const firstApp = apps.data?.[0]?.slug;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section aria-label={t("quick.label")}>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <QuickAction icon={Plus} entity="apps" title={t("quick.newApp")} subtitle={t("quick.newAppHint")} to="/$org/apps/new" params={{ org }} />
          {isAdmin ? (
            <QuickAction
              icon={FolderPlus}
              entity="projects"
              title={t("quick.newProject")}
              subtitle={t("quick.newProjectHint")}
              onClick={() => setCreateOpen(true)}
            />
          ) : null}
          <QuickAction
            icon={UserPlus}
            entity="members"
            title={t("quick.inviteMember")}
            subtitle={t("quick.inviteMemberHint")}
            to="/$org/settings/members"
            params={{ org }}
          />
          <QuickAction
            icon={KeyRound}
            entity="tokens"
            title={t("quick.createToken")}
            subtitle={t("quick.createTokenHint")}
            to="/$org/settings/tokens"
            params={{ org }}
          />
          <QuickAction
            icon={Globe}
            entity="domains"
            title={t("quick.addDomain")}
            subtitle={t("quick.addDomainHint")}
            to={firstApp ? "/$org/apps/$app/domains" : "/$org/apps/new"}
            params={firstApp ? { org, app: firstApp } : { org }}
          />
        </ul>
      </section>
      <ProjectsCard org={org} />
      <div className="grid gap-6 lg:grid-cols-2">
        <AppsCard org={org} />
        <MembersCard org={org} />
      </div>
      <ActivityCard org={org} canSee={isAdmin} />
      {isAdmin ? <CreateProjectDialog org={org} open={createOpen} onOpenChange={setCreateOpen} /> : null}
    </div>
  );
}
