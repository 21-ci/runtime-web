import { useEffect, useState } from "react";
import { Command } from "cmdk";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Boxes, FolderOpen, FolderPlus, Plus, Settings } from "lucide-react";

import { CreateProjectDialog } from "@/components/features/org/create-project-dialog";
import { useApps, useOrgs, useProjects } from "@/hooks/orgs";
import { SETTINGS_REGISTRY } from "./settings-registry";

const ITEM = "flex cursor-pointer items-center gap-2 rounded-[6px] px-3 py-2 text-sm text-text aria-selected:bg-panel-2";
const HEADING = "text-xs text-muted";

// CommandMenu is the ⌘K / Ctrl+K palette: apps, projects, settings and actions. Opening is global;
// the items are scoped to the current org.
export function CommandMenu({ org }: { org: string }) {
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();
  const router = useRouter();
  const orgs = useOrgs();
  const projects = useProjects(org);
  const apps = useApps(org);

  const role = orgs.data?.find((o) => o.slug === org)?.role;
  const canCreateProject = role === "owner" || role === "admin";
  // Entries appear only for routes the router actually has.
  const settings = SETTINGS_REGISTRY.filter((e) => e.path in router.routesByPath);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function run(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <>
      <Command.Dialog
        open={open}
        onOpenChange={setOpen}
        label="Command menu"
        className="fixed left-1/2 top-[15vh] z-50 w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-[12px] border border-line bg-surface text-text shadow-lg"
      >
        <Command.Input
          placeholder="Search apps, projects and actions"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted"
        />
        <Command.List className="max-h-[50vh] overflow-y-auto p-2">
          <Command.Empty className="px-3 py-6 text-center text-sm text-muted">No matches.</Command.Empty>

          <Command.Group heading="Actions" className={HEADING}>
            <Command.Item
              value="new app"
              onSelect={() => run(() => void navigate({ to: "/$org/apps/new", params: { org }, search: {} }))}
              className={ITEM}
            >
              <Plus className="size-4" aria-hidden="true" /> New app
            </Command.Item>
            {canCreateProject ? (
              <Command.Item value="new project" onSelect={() => run(() => setCreateOpen(true))} className={ITEM}>
                <FolderPlus className="size-4" aria-hidden="true" /> New project
              </Command.Item>
            ) : null}
          </Command.Group>

          {settings.length > 0 ? (
            <Command.Group heading="Go to settings" className={HEADING}>
              {settings.map((e) => (
                <Command.Item
                  key={e.path}
                  value={`settings ${e.label}`}
                  onSelect={() => run(() => void navigate({ href: e.path.replace("$org", org) }))}
                  className={ITEM}
                >
                  <Settings className="size-4 text-muted" aria-hidden="true" /> {e.label}
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}

          {(projects.data ?? []).length > 0 ? (
            <Command.Group heading="Projects" className={HEADING}>
              {(projects.data ?? []).map((p) => (
                <Command.Item
                  key={p.slug}
                  value={`project ${p.name} ${p.slug}`}
                  onSelect={() =>
                    run(() => void navigate({ to: "/$org/projects/$p", params: { org, p: p.slug } }))
                  }
                  className={ITEM}
                >
                  <FolderOpen className="size-4 text-muted" aria-hidden="true" /> {p.name}
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}

          {(apps.data ?? []).length > 0 ? (
            <Command.Group heading="Apps" className={HEADING}>
              {(apps.data ?? []).map((a) => (
                <Command.Item
                  key={`${a.project}/${a.slug}`}
                  value={`app ${a.name ?? ""} ${a.slug}`}
                  onSelect={() => run(() => void navigate({ to: "/$org/apps/$app", params: { org, app: a.slug } }))}
                  className={ITEM}
                >
                  <Boxes className="size-4 text-muted" aria-hidden="true" /> {a.name ?? a.slug}
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}
        </Command.List>
      </Command.Dialog>

      {canCreateProject ? (
        <CreateProjectDialog org={org} open={createOpen} onOpenChange={setCreateOpen} />
      ) : null}
    </>
  );
}
