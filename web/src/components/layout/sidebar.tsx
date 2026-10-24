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
import { Skeleton } from "@/components/ui/skeleton";
import { useApps, useProjects } from "@/hooks/orgs";
import { cn } from "@/lib/utils";
import { useCreateAppGate } from "./create-app-gate";
import { OrgSwitcher } from "./org-switcher";

// ROW is a 28px Notion-style sidebar row; ACTIVE is the overlay wash for the current page.
const ROW =
  "flex h-7 min-w-0 items-center gap-2 rounded-sm px-2 text-sm text-text outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus";
const ACTIVE = { className: "bg-active font-medium" };
const ROW_ACTION =
  "grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-muted opacity-0 outline-none hover:bg-active hover:text-text focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-focus group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100";

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="px-2 pb-1 pt-3 text-xs font-medium text-muted">{children}</p>;
}

function NavLink({
  to,
  params,
  icon: Icon,
  label,
  onNavigate,
  exact,
}: {
  to: string;
  params?: Record<string, string>;
  icon: LucideIcon;
  label: string;
  onNavigate?: () => void;
  exact?: boolean;
}) {
  return (
    <Link to={to} params={params} onClick={onNavigate} activeOptions={{ exact }} className={ROW} activeProps={ACTIVE}>
      <Icon className="size-4 shrink-0 text-muted" aria-hidden="true" />
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
    <nav aria-label="Sidebar" className="flex min-h-full flex-col gap-px px-2 py-2">
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
        <NavLink to="/$org" params={{ org }} icon={LayoutDashboard} label="Overview" onNavigate={onNavigate} exact />
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
            <div className="group relative flex items-center rounded-sm">
              <Link
                to="/$org/projects/$p"
                params={{ org, p: p.slug }}
                onClick={onNavigate}
                className={cn(ROW, "flex-1 pr-14")}
                activeProps={ACTIVE}
              >
                <FolderOpen className="size-4 shrink-0 text-muted" aria-hidden="true" />
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
                    className={cn(ROW, "pl-8 text-muted hover:text-text")}
                    activeProps={{
                      className: "bg-active font-medium text-text",
                    }}
                  >
                    <span className="truncate">{a.name ?? a.slug}</span>
                  </Link>
                </li>
              ))}
              {apps.isSuccess && own.length === 0 ? (
                <li className="py-1 pl-8 pr-2 text-[13px] text-muted">No apps</li>
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
          label="Settings"
          onNavigate={onNavigate}
        />
        <NavLink to="/me/security" icon={ShieldCheck} label="Account security" onNavigate={onNavigate} />
        {isAdmin ? <NavLink to="/admin" icon={Shield} label="Admin" onNavigate={onNavigate} /> : null}
      </div>
    </nav>
  );
}
