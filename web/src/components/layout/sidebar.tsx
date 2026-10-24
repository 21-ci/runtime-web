import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronsLeft,
  FolderOpen,
  LayoutDashboard,
  MoreHorizontal,
  Plus,
  Settings,
  Shield,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { useIsInstanceAdmin } from "@/components/features/admin/gate";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTile, type Entity } from "@/components/ui/icon-tile";
import { Skeleton } from "@/components/ui/skeleton";
import { useApps, useProjects } from "@/hooks/orgs";
import { cn } from "@/lib/utils";
import { useCreateAppGate } from "./create-app-gate";
import { OrgSwitcher } from "./org-switcher";

// ROW is a 32px rounded sidebar row; ACTIVE lifts the current page into a white pill.
const ROW =
  "flex h-8 min-w-0 items-center gap-2.5 rounded-lg px-2 text-sm text-text outline-none transition-[background-color,box-shadow,color] duration-[160ms] ease-ui hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus";
const ACTIVE = { className: "bg-surface font-medium shadow-card hover:bg-surface" };
const ROW_ACTION =
  "grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted transition-opacity opacity-0 outline-none hover:bg-active hover:text-text focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-focus group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100";

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="px-2 pb-1.5 pt-4 text-xs font-medium text-muted">{children}</p>;
}

function NavLink({
  to,
  params,
  icon,
  entity,
  label,
  onNavigate,
  exact,
}: {
  to: string;
  params?: Record<string, string>;
  icon: LucideIcon;
  entity: Entity;
  label: string;
  onNavigate?: () => void;
  exact?: boolean;
}) {
  return (
    <Link to={to} params={params} onClick={onNavigate} activeOptions={{ exact }} className={ROW} activeProps={ACTIVE}>
      <IconTile icon={icon} entity={entity} size="sm" />
      <span className="truncate">{label}</span>
    </Link>
  );
}

// Sidebar lists projects, and under each project its apps, then the settings links. It renders
// in the fixed column (md+, where onCollapse is set) and inside the mobile sheet.
export function Sidebar({
  org,
  onNavigate,
  onCollapse,
}: {
  org: string;
  onNavigate?: () => void;
  onCollapse?: () => void;
}) {
  const projects = useProjects(org);
  const apps = useApps(org);
  const gate = useCreateAppGate(org);
  const isAdmin = useIsInstanceAdmin();
  const navigate = useNavigate();

  function newApp(project: string) {
    onNavigate?.();
    void navigate({
      to: "/$org/apps/new",
      params: { org },
      search: { project },
    });
  }

  return (
    <nav aria-label="Sidebar" className="flex min-h-full flex-col gap-0.5 px-2.5 py-3">
      <div className="group flex items-center gap-1">
        <OrgSwitcher org={org} />
        {onCollapse ? (
          <button
            type="button"
            aria-label="Collapse sidebar"
            title="Collapse sidebar (⌘\)"
            onClick={onCollapse}
            className={ROW_ACTION}
          >
            <ChevronsLeft className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="pt-1">
        <NavLink to="/$org" params={{ org }} icon={LayoutDashboard} entity="overview" label="Overview" onNavigate={onNavigate} exact />
      </div>

      <SectionLabel>Projects</SectionLabel>
      {projects.isPending ? (
        <div className="flex flex-col gap-2 px-2" aria-busy="true">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
        </div>
      ) : projects.isError ? (
        <div className="flex flex-col items-start gap-2 px-2 text-sm">
          <p className="text-muted">Could not load projects.</p>
          <Button variant="secondary" size="sm" onClick={() => void projects.refetch()}>
            Retry
          </Button>
        </div>
      ) : (projects.data ?? []).length === 0 ? (
        <p className="px-2 py-1 text-[13px] text-muted">No projects</p>
      ) : null}

      {(projects.data ?? []).map((p) => {
        const own = (apps.data ?? []).filter((a) => a.project === p.slug);
        const canCreate = gate.inProject(p.slug);
        return (
          <div key={p.slug} className="flex flex-col gap-px">
            <div className="group relative flex items-center rounded-lg">
              <Link
                to="/$org/projects/$p"
                params={{ org, p: p.slug }}
                onClick={onNavigate}
                className={cn(ROW, "flex-1 pr-14")}
                activeProps={ACTIVE}
              >
                <IconTile icon={FolderOpen} entity="projects" size="sm" />
                <span className="truncate">{p.name}</span>
              </Link>
              <div className="absolute right-1 flex items-center gap-0.5">
                <DropdownMenu>
                  <DropdownMenuTrigger aria-label={`More for ${p.name}`} className={ROW_ACTION}>
                    <MoreHorizontal className="size-4" aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem
                      onSelect={() => {
                        onNavigate?.();
                        void navigate({
                          to: "/$org/projects/$p",
                          params: { org, p: p.slug },
                        });
                      }}
                    >
                      <FolderOpen className="size-4" aria-hidden="true" /> Open project
                    </DropdownMenuItem>
                    {canCreate ? (
                      <DropdownMenuItem onSelect={() => newApp(p.slug)}>
                        <Plus className="size-4" aria-hidden="true" /> New app
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
                {canCreate ? (
                  <button
                    type="button"
                    aria-label={`New app in ${p.name}`}
                    title="New app"
                    onClick={() => newApp(p.slug)}
                    className={ROW_ACTION}
                  >
                    <Plus className="size-4" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>
            <ul className="flex flex-col gap-px">
              {own.map((a) => (
                <li key={`${a.project}/${a.slug}`}>
                  <Link
                    to="/$org/apps/$app"
                    params={{ org, app: a.slug }}
                    onClick={onNavigate}
                    className={cn(ROW, "h-7 pl-10 text-muted hover:text-text")}
                    activeProps={{
                      className: "bg-surface font-medium text-text shadow-card hover:bg-surface",
                    }}
                  >
                    <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-tag-blue-text/70" />
                    <span className="truncate">{a.name ?? a.slug}</span>
                  </Link>
                </li>
              ))}
              {apps.isSuccess && own.length === 0 ? (
                <li className="py-1 pl-10 pr-2 text-[13px] text-muted">No apps</li>
              ) : null}
            </ul>
          </div>
        );
      })}

      <div className="mt-auto flex flex-col gap-px pt-4">
        <NavLink
          to="/$org/settings/general"
          params={{ org }}
          icon={Settings}
          entity="settings"
          label="Settings"
          onNavigate={onNavigate}
        />
        <NavLink to="/me/security" icon={ShieldCheck} entity="security" label="Account security" onNavigate={onNavigate} />
        {isAdmin ? <NavLink to="/admin" icon={Shield} entity="admin" label="Admin" onNavigate={onNavigate} /> : null}
      </div>
    </nav>
  );
}
