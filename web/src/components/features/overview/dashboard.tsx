import { Link } from "@tanstack/react-router";
import {
  Boxes,
  ChevronDown,
  Eye,
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
import { useMembers } from "@/components/features/members/hooks";
import { CreateProjectDialog } from "@/components/features/org/create-project-dialog";
import { OrgAvatar } from "@/components/layout/org-switcher";
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
import { IconTile, type Entity } from "@/components/ui/icon-tile";
import { SectionCard, SMALL_CONTROL, SMALL_ICON } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useApps, useProjects } from "@/hooks/orgs";
import type { OrgRole } from "@/lib/types";
import { cn } from "@/lib/utils";

const BUILD_DOT: Record<string, string> = {
  ready: "bg-tag-green-text",
  building: "bg-tag-yellow-text",
  failed: "bg-tag-red-text",
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
  const cls =
    "flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl border border-line bg-surface p-3.5 text-left outline-none transition-[background-color,border-color,box-shadow] duration-[160ms] hover:border-line-strong hover:shadow-card focus-visible:ring-2 focus-visible:ring-focus";
  const body = (
    <>
      <IconTile icon={icon} entity={entity} size="md" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-text">{title}</span>
        <span className="block truncate text-xs text-muted">{subtitle}</span>
      </span>
    </>
  );
  return (
    <li className="min-w-0">
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
                <Plus className="size-4" aria-hidden="true" /> New app
              </Link>
            </DropdownMenuItem>
          </CardMenu>
        </>
      }
    >
      {apps.isPending ? (
        <SkeletonGrid />
      ) : list.length === 0 ? (
        <EmptyState entity="apps" icon={Boxes} title="No apps yet" description="Create an app to see it here." />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {list.map((a) => (
            <li key={`${a.project}/${a.slug}`} className="min-w-0">
              <Link
                to="/$org/apps/$app"
                params={{ org, app: a.slug }}
                className="flex h-full flex-col gap-3 rounded-xl border border-line p-4 outline-none transition-[border-color,box-shadow] duration-[160ms] hover:border-line-strong hover:shadow-card focus-visible:ring-2 focus-visible:ring-focus"
              >
                <IconTile icon={Boxes} entity="apps" size="md" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-text">{a.name ?? a.slug}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                    <span
                      aria-hidden="true"
                      className={cn("size-1.5 rounded-full", BUILD_DOT[a.status.build_state] ?? "bg-muted")}
                    />
                    {a.status.build_state} · {projectName(a.project)} / {a.environment}
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
        <EmptyState entity="audit" icon={ScrollText} title="Activity is for admins" description="Ask an owner or admin." />
      ) : activity.isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : activity.isError ? (
        <EmptyState entity="audit" icon={ScrollText} title="Could not load activity" />
      ) : items.length === 0 ? (
        <EmptyState entity="audit" icon={ScrollText} title="No activity yet" description="Changes in this org show up here." />
      ) : (
        <ol className="relative flex flex-col">
          {items.map((e, i) => {
            const who = e.actor.name ?? e.actor.email ?? "System";
            return (
              <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
                {i < items.length - 1 ? (
                  <span aria-hidden="true" className="absolute top-8 bottom-0 left-3.5 w-px bg-line" />
                ) : null}
                <OrgAvatar name={who} className="size-7 rounded-full text-[12px]" />
                <div className="min-w-0 flex-1 pt-0.5">
                  <p className="text-sm text-text">
                    <span className="font-medium">{who}</span>{" "}
                    <code className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[12px]">{e.action}</code>
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {e.target} · <time dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toLocaleString()}</time>
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
              <UserPlus className="size-4" aria-hidden="true" /> Invite member
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to="/$org/settings/members" params={{ org }}>
              <Eye className="size-4" aria-hidden="true" /> Manage members
            </Link>
          </DropdownMenuItem>
        </CardMenu>
      }
    >
      {members.isPending ? (
        <SkeletonGrid n={3} h="h-28" />
      ) : members.isError || list.length === 0 ? (
        <EmptyState entity="members" title="No members to show" />
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {list.map((m) => {
            const name = m.user.name ?? m.user.email;
            return (
              <li
                key={m.user.id}
                className="flex min-w-0 flex-col items-center gap-2 rounded-xl border border-line p-4 text-center"
              >
                <OrgAvatar name={name} className="size-11 rounded-full text-base" />
                <span className="min-w-0 max-w-full">
                  <span className="block truncate text-sm font-medium text-text">{name}</span>
                  <span className="block truncate text-xs text-muted">{m.user.email}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

// Dashboard is the org overview: quick actions, then apps, activity and members cards.
export function Dashboard({ org, role }: { org: string; role: OrgRole | null | undefined }) {
  const apps = useApps(org);
  const [createOpen, setCreateOpen] = useState(false);
  const isAdmin = role === "owner" || role === "admin";
  const firstApp = apps.data?.[0]?.slug;

  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Quick actions">
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
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
            to={firstApp ? "/$org/apps/$app/settings" : "/$org/apps/new"}
            params={firstApp ? { org, app: firstApp } : { org }}
          />
        </ul>
      </section>
      <div className="grid gap-5 lg:grid-cols-2">
        <AppsCard org={org} />
        <ActivityCard org={org} canSee={isAdmin} />
        <MembersCard org={org} />
      </div>
      {isAdmin ? <CreateProjectDialog org={org} open={createOpen} onOpenChange={setCreateOpen} /> : null}
    </div>
  );
}
