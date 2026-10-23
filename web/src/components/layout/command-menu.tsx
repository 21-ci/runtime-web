import { useEffect, useState } from "react";
import { Command } from "cmdk";
import { useNavigate } from "@tanstack/react-router";
import { Boxes, FolderOpen, Plus } from "lucide-react";

import { useApps, useProjects } from "@/hooks/orgs";

// CommandMenu is the ⌘K / Ctrl+K palette: apps, projects and actions. Opening is global; the
// items are scoped to the current org.
export function CommandMenu({ org }: { org: string }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const projects = useProjects(org);
  const apps = useApps(org);

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

  function close() {
    setOpen(false);
  }

  return (
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

        <Command.Group heading="Actions" className="text-xs text-muted">
          <Command.Item
            value="new app"
            onSelect={() => {
              close();
              void navigate({ to: "/$org/apps/new", params: { org }, search: {} });
            }}
            className="flex cursor-pointer items-center gap-2 rounded-[6px] px-3 py-2 text-sm aria-selected:bg-panel-2"
          >
            <Plus className="size-4" aria-hidden="true" /> New app
          </Command.Item>
        </Command.Group>

        {(projects.data ?? []).length > 0 ? (
          <Command.Group heading="Projects" className="text-xs text-muted">
            {(projects.data ?? []).map((p) => (
              <Command.Item
                key={p.slug}
                value={`project ${p.name} ${p.slug}`}
                onSelect={() => {
                  close();
                  void navigate({ to: "/$org/projects/$p", params: { org, p: p.slug } });
                }}
                className="flex cursor-pointer items-center gap-2 rounded-[6px] px-3 py-2 text-sm text-text aria-selected:bg-panel-2"
              >
                <FolderOpen className="size-4 text-muted" aria-hidden="true" /> {p.name}
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        {(apps.data ?? []).length > 0 ? (
          <Command.Group heading="Apps" className="text-xs text-muted">
            {(apps.data ?? []).map((a) => (
              <Command.Item
                key={`${a.project}/${a.slug}`}
                value={`app ${a.name ?? ""} ${a.slug}`}
                onSelect={() => {
                  close();
                  void navigate({ to: "/$org/apps/$app", params: { org, app: a.slug } });
                }}
                className="flex cursor-pointer items-center gap-2 rounded-[6px] px-3 py-2 text-sm text-text aria-selected:bg-panel-2"
              >
                <Boxes className="size-4 text-muted" aria-hidden="true" /> {a.name ?? a.slug}
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
      </Command.List>
    </Command.Dialog>
  );
}
