import { Link } from "@tanstack/react-router";
import {
  Boxes,
  ChevronDown,
  Eye,
  FolderOpen,
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

import { useRecentActivity } from "@/components/features/audit/hooks";
import { NoProjects } from "@/components/features/empty/no-projects";
import { QueryError } from "@/components/features/empty/query-error";
import { useMembers } from "@/components/features/members/hooks";
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
import { formatRelative } from "@/lib/format";
import type { OrgRole } from "@/lib/types";

const PROJECT_HUES: Hue[] = ["green", "blue", "pink", "yellow", "purple", "teal", "orange"];

const BUILD_VARIANT: Record<string, "success" | "danger" | "warning" | "default"> = {
  ready: "success",
  failed: "danger",
  building: "warning",
  pending: "warning",
};

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
    "flex h-full w-full min-w-0 cursor-pointer flex-col items-start gap-2.5 rounded-lg border border-line bg-surface p-3.5 text-left shadow-card outline-none transition-[background-color,border-color,box-shadow] duration-[140ms] hover:border-line-strong hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus";
  const body = (
    <>
      <IconTile icon={icon} entity={entity} size="md" solid />
      <span className="flex w-full min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-text" title={title}>
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
  const projects = useProjects(org);
  const apps = useApps(org);
  const list = projects.data ?? [];
  return (
    <section aria-labelledby="projects-heading" className="flex flex-col gap-3">
      <h2 id="projects-heading" className="text-[15px] font-semibold">
        Projects
      </h2>
      {projects.isError ? (
        <QueryError error={projects.error} onRetry={() => void projects.refetch()} notFoundTitle="Organization not found" />
      ) : projects.isPending ? (
        <SkeletonGrid n={2} h="h-20" />
      ) : list.length === 0 ? (
        <NoProjects org={org} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((p, i) => {
            const count = (apps.data ?? []).filter((a) => a.project === p.slug).length;
            return (
              <li key={p.slug} className="flex min-w-0">
                <Link
                  to="/$org/projects/$p"
                  params={{ org, p: p.slug }}
                  className="flex h-full w-full min-w-0 items-center gap-3 rounded-lg border border-line bg-surface p-3.5 shadow-card outline-none transition-[border-color,background-color] duration-[140ms] hover:border-line-strong hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <IconTile icon={FolderOpen} hue={PROJECT_HUES[i % PROJECT_HUES.length]} size="md" solid />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-text" title={p.name}>
                      {p.name}
                    </span>
                    <span className="block truncate text-[12px] text-muted" title={p.environments.join(", ")}>
                      {apps.data ? `${count} ${count === 1 ? "app" : "apps"} · ` : ""}
                      {p.environments.join(", ")}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function AppsCard({ org }: { org: string }) {
  const apps = useApps(org);
  const projects = useProjects(org);
  const [project, setProject] = useState("*");
  const list = (apps.data ?? []).filter((a) => project === "*" || a.project === project);
  const projectName = (slug: string) => projects.data?.find((p) => p.slug === slug)?.name ?? slug;

  return (
    <SectionCard
      title="Apps"
      actions={
        <>
          <DropdownMenu>
            <DropdownMenuTrigger className={SMALL_CONTROL} aria-label="Filter apps by project">
              {project === "*" ? "All projects" : projectName(project)}
              <ChevronDown aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Project</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={project} onValueChange={setProject}>
                <DropdownMenuRadioItem value="*">All projects</DropdownMenuRadioItem>
                {(projects.data ?? []).map((p) => (
                  <DropdownMenuRadioItem key={p.slug} value={p.slug}>
                    {p.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <CardMenu label="Apps menu">
            <DropdownMenuItem asChild>
              <Link to="/$org/apps/new" params={{ org }}>
                <Plus aria-hidden="true" /> New app
              </Link>
            </DropdownMenuItem>
          </CardMenu>
        </>
      }
    >
      {apps.isPending ? (
        <SkeletonGrid />
      ) : list.length === 0 ? (
        <EmptyState bare entity="apps" icon={Boxes} title="No apps yet" description="Create an app to see it here." />
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
                      {a.status.build_state}
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
  const activity = useRecentActivity(org, canSee);
  const items = activity.data ?? [];
  return (
    <SectionCard
      title="Recent activity"
      actions={
        canSee ? (
          <Link to="/$org/settings/audit" params={{ org }} className={SMALL_CONTROL}>
            View all
          </Link>
        ) : null
      }
    >
      {!canSee ? (
        <EmptyState bare entity="audit" icon={ScrollText} title="Activity is for admins" description="Ask an owner or admin." />
      ) : activity.isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : activity.isError ? (
        <EmptyState bare entity="audit" icon={ScrollText} title="Could not load activity" />
      ) : items.length === 0 ? (
        <EmptyState bare entity="audit" icon={ScrollText} title="No activity yet" description="Changes in this org show up here." />
      ) : (
        <ol className="relative flex flex-col">
          {items.map((e, i) => {
            const who = e.actor.name ?? e.actor.email ?? "System";
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
                    <time dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString()}>
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
  const members = useMembers(org);
  const list = members.data ?? [];
  return (
    <SectionCard
      title={members.data ? `Members (${list.length})` : "Members"}
      actions={
        <CardMenu label="Members menu">
          <DropdownMenuItem asChild>
            <Link to="/$org/settings/members" params={{ org }}>
              <UserPlus aria-hidden="true" /> Invite member
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to="/$org/settings/members" params={{ org }}>
              <Eye aria-hidden="true" /> Manage members
            </Link>
          </DropdownMenuItem>
        </CardMenu>
      }
    >
      {members.isPending ? (
        <SkeletonGrid n={3} h="h-24" />
      ) : members.isError || list.length === 0 ? (
        <EmptyState bare entity="members" title="No members to show" />
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {list.map((m) => {
            const name = m.user.name ?? m.user.email;
            return (
              <li key={m.user.id} className="flex h-full min-w-0 flex-col items-center gap-2 rounded-lg border border-line p-4 text-center">
                <OrgAvatar name={name} solid className="size-10 rounded-full text-[15px]" />
                <span className="w-full min-w-0">
                  <span className="block truncate text-sm font-medium text-text" title={name}>
                    {name}
                  </span>
                  <span className="block truncate text-[12px] text-muted" title={m.user.email}>
                    {m.user.email}
                  </span>
                </span>
                <Badge className="capitalize">{m.role}</Badge>
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
  const apps = useApps(org);
  const [createOpen, setCreateOpen] = useState(false);
  const isAdmin = role === "owner" || role === "admin";
  const firstApp = apps.data?.[0]?.slug;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section aria-label="Quick actions">
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <QuickAction icon={Plus} entity="apps" title="New app" subtitle="Deploy code in seconds" to="/$org/apps/new" params={{ org }} />
          {isAdmin ? (
            <QuickAction icon={FolderPlus} entity="projects" title="New project" subtitle="Group apps together" onClick={() => setCreateOpen(true)} />
          ) : null}
          <QuickAction icon={UserPlus} entity="members" title="Invite member" subtitle="Bring your team in" to="/$org/settings/members" params={{ org }} />
          <QuickAction icon={KeyRound} entity="tokens" title="Create token" subtitle="Access the API" to="/$org/settings/tokens" params={{ org }} />
          <QuickAction
            icon={Globe}
            entity="domains"
            title="Add domain"
            subtitle="Serve an app on your URL"
            to={firstApp ? "/$org/apps/$app/domains" : "/$org/apps/new"}
            params={firstApp ? { org, app: firstApp } : { org }}
          />
        </ul>
      </section>
      <ProjectsCard org={org} />
      <div className="grid gap-6 lg:grid-cols-2">
        <AppsCard org={org} />
        <ActivityCard org={org} canSee={isAdmin} />
        <div className="lg:col-span-2">
          <MembersCard org={org} />
        </div>
      </div>
      {isAdmin ? <CreateProjectDialog org={org} open={createOpen} onOpenChange={setCreateOpen} /> : null}
    </div>
  );
}
