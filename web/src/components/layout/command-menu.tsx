import { useState } from "react";
import { Command } from "cmdk";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  Boxes,
  FolderOpen,
  FolderPlus,
  LayoutDashboard,
  PanelLeft,
  Plus,
  Settings,
  Shield,
  ShieldCheck,
  SunMoon,
} from "lucide-react";

import { useIsInstanceAdmin } from "@/components/features/admin/gate";
import { CreateProjectDialog } from "@/components/features/org/create-project-dialog";
import { useApps, useOrgs, useProjects } from "@/hooks/orgs";
import { useCreateAppGate } from "./create-app-gate";
import { visibleSettings } from "./settings-registry";
import { useShell } from "./shell-context";

const ITEM =
  "flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-sm text-text transition-colors duration-[120ms] data-[selected=true]:bg-hover";
const HEADING =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted";
const ICON = "size-4 shrink-0 text-muted";

// settingsIcon picks the icon for a registry entry by its section.
function settingsIcon(path: string) {
  if (path.startsWith("/admin")) return Shield;
  if (path.startsWith("/me")) return ShieldCheck;
  return Settings;
}

// CommandMenu is the ⌘K / Ctrl+K palette: actions, navigation, settings, projects and apps.
// AppShell owns the open state and the shortcut; the items are scoped to the current org.
export function CommandMenu({ org }: { org: string }) {
  const { paletteOpen, setPaletteOpen, theme, setTheme, collapsed, setCollapsed } = useShell();
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();
  const router = useRouter();
  const orgs = useOrgs();
  const projects = useProjects(org);
  const apps = useApps(org);
  const gate = useCreateAppGate(org);

  const role = orgs.data?.find((o) => o.slug === org)?.role;
  const canCreateProject = role === "owner" || role === "admin";
  const isAdmin = useIsInstanceAdmin();
  // Entries appear only for routes the router actually has; admin entries only for instance admins.
  const settings = visibleSettings(router.routesByPath, isAdmin);
  const projectName = (slug: string) => projects.data?.find((p) => p.slug === slug)?.name ?? slug;
  const isDark = theme === "dark" || (theme === "system" && document.documentElement.classList.contains("dark"));

  function run(action: () => void) {
    setPaletteOpen(false);
    action();
  }

  return (
    <>
      <Command.Dialog
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        label="Command menu"
        overlayClassName="fixed inset-0 z-50 bg-overlay/30"
        contentClassName="fixed left-1/2 top-[14vh] z-50 w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-surface text-text shadow-menu outline-none"
      >
        <Command.Input
          placeholder="Search apps, projects, actions…"
          className="h-12 w-full border-b border-line bg-transparent px-4 text-sm outline-none placeholder:text-muted"
        />
        <Command.List className="max-h-[min(50vh,420px)] overflow-y-auto p-1.5">
          <Command.Empty className="px-3 py-6 text-center text-sm text-muted">No matches.</Command.Empty>

          <Command.Group heading="Actions" className={HEADING}>
            {gate.any ? (
              <Command.Item
                value="new app"
                onSelect={() =>
                  run(
                    () =>
                      void navigate({
                        to: "/$org/apps/new",
                        params: { org },
                        search: {},
                      }),
                  )
                }
                className={ITEM}
              >
                <Plus className={`${ICON} text-tag-orange-text`} aria-hidden="true" /> New app
              </Command.Item>
            ) : null}
            {canCreateProject ? (
              <Command.Item value="new project" onSelect={() => run(() => setCreateOpen(true))} className={ITEM}>
                <FolderPlus className={`${ICON} text-tag-yellow-text`} aria-hidden="true" /> New project
              </Command.Item>
            ) : null}
            <Command.Item
              value="toggle theme dark light"
              onSelect={() => run(() => setTheme(isDark ? "light" : "dark"))}
              className={ITEM}
            >
              <SunMoon className={ICON} aria-hidden="true" /> Toggle theme
            </Command.Item>
            <Command.Item
              value="toggle sidebar collapse expand"
              onSelect={() => run(() => setCollapsed(!collapsed))}
              className={`${ITEM} hidden md:flex`}
            >
              <PanelLeft className={ICON} aria-hidden="true" /> {collapsed ? "Expand sidebar" : "Collapse sidebar"}
            </Command.Item>
          </Command.Group>

          <Command.Group heading="Go to" className={HEADING}>
            <Command.Item
              value="go to overview home"
              onSelect={() => run(() => void navigate({ to: "/$org", params: { org } }))}
              className={ITEM}
            >
              <LayoutDashboard className={`${ICON} text-tag-orange-text`} aria-hidden="true" /> Go to Overview
            </Command.Item>
            {isAdmin ? (
              <Command.Item
                value="admin instance"
                onSelect={() => run(() => void navigate({ to: "/admin" }))}
                className={ITEM}
              >
                <Shield className={`${ICON} text-tag-red-text`} aria-hidden="true" /> Admin
              </Command.Item>
            ) : null}
          </Command.Group>

          {settings.length > 0 ? (
            <Command.Group heading="Settings" className={HEADING}>
              {settings.map((e) => {
                const Icon = settingsIcon(e.path);
                return (
                  <Command.Item
                    key={e.path}
                    value={`settings ${e.label}`}
                    onSelect={() => run(() => void navigate({ href: e.path.replace("$org", org) }))}
                    className={ITEM}
                  >
                    <Icon className={ICON} aria-hidden="true" /> {e.label}
                  </Command.Item>
                );
              })}
            </Command.Group>
          ) : null}

          {(projects.data ?? []).length > 0 ? (
            <Command.Group heading="Projects" className={HEADING}>
              {(projects.data ?? []).map((p) => (
                <Command.Item
                  key={p.slug}
                  value={`project ${p.name} ${p.slug}`}
                  onSelect={() =>
                    run(
                      () =>
                        void navigate({
                          to: "/$org/projects/$p",
                          params: { org, p: p.slug },
                        }),
                    )
                  }
                  className={ITEM}
                >
                  <FolderOpen className={`${ICON} text-tag-yellow-text`} aria-hidden="true" /> {p.name}
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}

          {(apps.data ?? []).length > 0 ? (
            <Command.Group heading="Apps" className={HEADING}>
              {(apps.data ?? []).map((a) => (
                <Command.Item
                  key={`${a.project}/${a.slug}`}
                  value={`app ${a.name ?? ""} ${a.slug} ${a.project}`}
                  onSelect={() =>
                    run(
                      () =>
                        void navigate({
                          to: "/$org/apps/$app",
                          params: { org, app: a.slug },
                        }),
                    )
                  }
                  className={ITEM}
                >
                  <Boxes className={`${ICON} text-tag-blue-text`} aria-hidden="true" />
                  <span className="truncate">{a.name ?? a.slug}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted">{projectName(a.project)}</span>
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}
        </Command.List>
        <div className="flex h-8 items-center gap-3 border-t border-line px-3 text-xs text-muted">
          <span>↑↓ to navigate</span>
          <span>↵ to select</span>
          <span>esc to close</span>
        </div>
      </Command.Dialog>

      {canCreateProject ? <CreateProjectDialog org={org} open={createOpen} onOpenChange={setCreateOpen} /> : null}
    </>
  );
}
