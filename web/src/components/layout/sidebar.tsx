import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronsLeft,
  FolderOpen,
  KeyRound,
  LayoutDashboard,
  MoreHorizontal,
  Plus,
  Settings,
  Shield,
  ScrollText,
  Search,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { CreateProjectDialog } from "@/components/features/org/create-project-dialog";
import { useIsInstanceAdmin } from "@/components/features/admin/gate";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTile, type Hue } from "@/components/ui/icon-tile";
import { Skeleton } from "@/components/ui/skeleton";
import { useApps, useOrgs, useProjects } from "@/hooks/orgs";
import { cn } from "@/lib/utils";
import { useCreateAppGate } from "./create-app-gate";
import { OrgSwitcher } from "./org-switcher";
import { SHORTCUT_LABEL, useShell } from "./shell-context";

// PROJECT_HUES gives each project (a "space") its own small colourful icon.
const PROJECT_HUES: Hue[] = ["green", "blue", "pink", "yellow", "purple", "teal", "orange"];

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
  const { setPaletteOpen } = useShell();
  const orgs = useOrgs();
  const role = orgs.data?.find((o) => o.slug === org)?.role;
  const canCreateProject = role === "owner" || role === "admin";
  const [createOpen, setCreateOpen] = useState(false);

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

      <button
        type="button"
        onClick={() => {
          onNavigate?.();
          setPaletteOpen(true);
        }}
        aria-label="Open command menu"
        className="mt-2 mb-1 flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-sm text-muted outline-none transition-[border-color,box-shadow] duration-[160ms] hover:border-line-strong focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Search className="size-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 text-left">Search…</span>
        <kbd className="rounded-md bg-panel-2 px-1.5 font-mono text-[11px]">{SHORTCUT_LABEL}</kbd>
      </button>

      <div className="flex flex-col gap-0.5 pt-1">
        <NavLink to="/$org" params={{ org }} icon={LayoutDashboard} label="Dashboard" onNavigate={onNavigate} exact />
        <NavLink to="/$org/settings/members" params={{ org }} icon={Users} label="Members" onNavigate={onNavigate} />
        <NavLink to="/$org/settings/tokens" params={{ org }} icon={KeyRound} label="Tokens" onNavigate={onNavigate} />
        <NavLink to="/$org/settings/audit" params={{ org }} icon={ScrollText} label="Audit log" onNavigate={onNavigate} />
      </div>

      <div className="group/projects flex items-center pr-1">
        <SectionLabel>Projects</SectionLabel>
        <span className="ml-auto flex items-center gap-0.5 pt-3">
          <button
            type="button"
            aria-label="Search projects and apps"
            title="Search"
            onClick={() => {
              onNavigate?.();
              setPaletteOpen(true);
            }}
            className={cn(ROW_ACTION, "group-hover/projects:opacity-100")}
          >
            <Search className="size-3.5" aria-hidden="true" />
          </button>
          {canCreateProject ? (
            <button
              type="button"
              aria-label="New project"
              title="New project"
              onClick={() => setCreateOpen(true)}
              className={cn(ROW_ACTION, "group-hover/projects:opacity-100")}
            >
              <Plus className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </span>
      </div>
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

      {(projects.data ?? []).map((p, i) => {
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
                <IconTile icon={FolderOpen} hue={PROJECT_HUES[i % PROJECT_HUES.length]} size="xs" />
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
         
          label="Settings"
          onNavigate={onNavigate}
        />
        <NavLink to="/me/security" icon={ShieldCheck} label="Account security" onNavigate={onNavigate} />
        {isAdmin ? <NavLink to="/admin" icon={Shield} label="Admin" onNavigate={onNavigate} /> : null}
      </div>
      {canCreateProject ? <CreateProjectDialog org={org} open={createOpen} onOpenChange={setCreateOpen} /> : null}
    </nav>
  );
}
