import { Link } from "@tanstack/react-router";
import { ArrowLeft, Building2, Database, Globe, ScrollText, Server, Settings, Shield, Users } from "lucide-react";
import type { ReactNode } from "react";

import { AppShell } from "@/components/layout/app-shell";
import { NavLink, SidebarFrame } from "@/components/layout/sidebar";
import { IconTile } from "@/components/ui/icon-tile";
import { useOrgs } from "@/hooks/orgs";

const SECTIONS = [
  { to: "/admin/users", label: "Users", icon: Users },
  { to: "/admin/orgs", label: "Organizations", icon: Building2 },
  { to: "/admin/audit", label: "Audit log", icon: ScrollText },
  { to: "/admin/node", label: "Node", icon: Server },
  { to: "/admin/cache", label: "Cache", icon: Database },
  { to: "/admin/domains", label: "Domains", icon: Globe },
  { to: "/admin/settings", label: "Settings", icon: Settings },
] as const;

function AdminNav({ onNavigate, onCollapse }: { onNavigate?: () => void; onCollapse?: () => void }) {
  return (
    <SidebarFrame
      label="Admin sections"
      top={
        <div className="flex h-9 min-w-0 flex-1 items-center gap-2 px-1.5 text-sm">
          <IconTile icon={Shield} entity="admin" size="sm" solid />
          <span className="truncate font-semibold">Instance admin</span>
        </div>
      }
      onCollapse={onCollapse}
      footer={
        <Link
          to="/"
          onClick={onNavigate}
          className="flex h-7 items-center gap-2 rounded-md px-2 text-sm text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to console
        </Link>
      }
    >
      <div className="flex flex-col gap-px pt-2">
        {SECTIONS.map((s) => (
          <NavLink key={s.to} to={s.to} icon={s.icon} label={s.label} onNavigate={onNavigate} />
        ))}
      </div>
    </SidebarFrame>
  );
}

// AdminLayout frames the instance-admin pages in the console shell with their own sidebar. They
// sit outside an org, so the palette is scoped to the user's first org when there is one.
export function AdminLayout({ children }: { children: ReactNode }) {
  const orgs = useOrgs();
  const first = orgs.data?.[0]?.slug ?? null;
  return (
    <AppShell
      org={first}
      nav={(props) => <AdminNav {...props} />}
      crumbs={
        <p className="min-w-0 flex-1 truncate text-sm">
          <span className="text-muted">Admin</span>
        </p>
      }
    >
      {children}
    </AppShell>
  );
}
