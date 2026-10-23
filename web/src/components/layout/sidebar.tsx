import { Link } from "@tanstack/react-router";
import { LayoutDashboard } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { useApps, useProjects } from "@/hooks/orgs";
import { OrgSwitcher } from "./org-switcher";

// Sidebar lists projects, and under each project its apps. Used both in the fixed column (md+)
// and inside the mobile sheet, so it takes no state of its own.
export function Sidebar({ org, onNavigate }: { org: string; onNavigate?: () => void }) {
  const projects = useProjects(org);
  const apps = useApps(org);

  return (
    <nav aria-label="Sidebar" className="flex flex-col gap-3 p-3">
      <OrgSwitcher org={org} />
      <Link
        to="/$org"
        params={{ org }}
        onClick={onNavigate}
        activeOptions={{ exact: true }}
        className="flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-text hover:bg-panel-2"
        activeProps={{ className: "bg-blue-pale font-semibold" }}
      >
        <LayoutDashboard className="size-4 text-muted" aria-hidden="true" />
        Overview
      </Link>

      <div className="flex flex-col gap-0.5">
        <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted">Projects</p>
        {projects.isPending ? (
          <div className="flex flex-col gap-2 px-2" aria-busy="true">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-3/4" />
          </div>
        ) : null}
        {(projects.data ?? []).map((p) => {
          const own = (apps.data ?? []).filter((a) => a.project === p.slug);
          return (
            <div key={p.slug} className="flex flex-col">
              <Link
                to="/$org/projects/$p"
                params={{ org, p: p.slug }}
                onClick={onNavigate}
                className="rounded-[8px] px-2 py-1.5 text-text hover:bg-panel-2"
                activeProps={{ className: "bg-blue-pale font-semibold" }}
              >
                {p.name}
              </Link>
              <ul className="ml-3 flex flex-col border-l border-line pl-2">
                {own.map((a) => (
                  <li key={`${a.project}/${a.slug}`}>
                    <Link
                      to="/$org/apps/$app"
                      params={{ org, app: a.slug }}
                      onClick={onNavigate}
                      className="block truncate rounded-[6px] px-2 py-1 text-sm text-muted hover:bg-panel-2 hover:text-text"
                      activeProps={{ className: "text-text font-medium" }}
                    >
                      {a.name ?? a.slug}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
