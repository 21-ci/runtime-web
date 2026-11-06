import { Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import {
  Archive,
  BellRing,
  Boxes,
  Building2,
  ChartNoAxesColumn,
  ChevronRight,
  Clock,
  Code2,
  Database,
  FolderOpen,
  Gauge,
  GitBranch,
  Globe,
  History,
  KeyRound,
  LayoutDashboard,
  Lock,
  MoreHorizontal,
  Plus,
  ScrollText,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { GlassSidebar, SidebarBrand as GlassBrand, type GlassNavGroup, type RenderNavLink } from "@/components/app-interface/sidebar-glass";
import { useIsInstanceAdmin } from "@/components/features/admin/gate";
import { UpdateNotice } from "@/components/features/admin/update-notice";
import { BrandLogo, defaultIcon } from "@/components/features/branding/brand";
import { isBranded, productName, useBranding } from "@/components/features/branding/hooks";
import { CreateProjectDialog } from "@/components/features/org/create-project-dialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconTile, type Hue } from "@/components/ui/icon-tile";
import { Kbd } from "@/components/ui/page-header";
import { SidebarGroup, useSidebar } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { useApps, useOrgs, useProjects } from "@/hooks/orgs";
import { cn } from "@/lib/utils";
import { useCreateAppGate } from "./create-app-gate";
import { OrgSwitcher } from "./org-switcher";
import { SHORTCUT_LABEL, useShell } from "./shell-context";

// PROJECT_HUES gives each project its own small soft tile.
const PROJECT_HUES: Hue[] = ["green", "blue", "pink", "yellow", "purple", "teal", "orange"];

// Rows that are not plain nav data (project tree, account link). The rail hides labels with ICON_HIDDEN.
const ROW =
  "flex h-8 min-w-0 items-center gap-2 rounded-full px-2 text-sm text-sidebar-foreground outline-none transition-[background-color,color] duration-[120ms] ease-ui hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring";
const ACTIVE = { className: "bg-sidebar-accent font-medium hover:bg-sidebar-accent" };
const ROW_ACTION =
  "grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted transition-opacity opacity-0 outline-none hover:bg-active hover:text-text focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-focus group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100";
const ICON_HIDDEN = "group-data-[collapsible=icon]:hidden";
const LABEL = "px-2 pb-1 pt-4 text-[12px] font-medium text-muted";

// INSTANCE_SECTIONS are the instance-admin pages. They form the Instance group of the normal
// sidebar, shown only to instance admins (the API authorizes every admin call regardless).
// labelKey is a key in the `shell` namespace.
export const INSTANCE_SECTIONS = [
  { to: "/admin/users", labelKey: "instance.users", icon: Users },
  { to: "/admin/orgs", labelKey: "instance.organizations", icon: Building2 },
  { to: "/admin/audit", labelKey: "instance.auditLog", icon: ScrollText },
  { to: "/admin/node", labelKey: "instance.node", icon: Server },
  { to: "/admin/cache", labelKey: "instance.cache", icon: Database },
  { to: "/admin/backups", labelKey: "instance.backups", icon: Archive },
  { to: "/admin/alerts", labelKey: "instance.alerts", icon: BellRing },
  { to: "/admin/domains", labelKey: "instance.domains", icon: Globe },
  { to: "/admin/settings", labelKey: "instance.settings", icon: Settings },
] as const satisfies readonly { to: string; labelKey: string; icon: LucideIcon }[];

// APP_SECTIONS is the app tab strip, in order. Overview is exact; `shortcut` is the key after "g".
// labelKey is a key in the `shell` namespace.
export const APP_SECTIONS: readonly { to: string; labelKey: AppSectionKey; icon: LucideIcon; shortcut: string; exact?: boolean }[] = [
  { to: "/$org/apps/$app", labelKey: "appNav.overview", icon: LayoutDashboard, shortcut: "o", exact: true },
  { to: "/$org/apps/$app/deployments", labelKey: "appNav.versions", icon: History, shortcut: "d" },
  { to: "/$org/apps/$app/logs", labelKey: "appNav.logs", icon: ScrollText, shortcut: "l" },
  { to: "/$org/apps/$app/analytics", labelKey: "appNav.analytics", icon: ChartNoAxesColumn, shortcut: "a" },
  { to: "/$org/apps/$app/code", labelKey: "appNav.code", icon: Code2, shortcut: "c" },
  { to: "/$org/apps/$app/data", labelKey: "appNav.data", icon: Database, shortcut: "x" },
  { to: "/$org/apps/$app/triggers", labelKey: "appNav.triggers", icon: Clock, shortcut: "t" },
  { to: "/$org/apps/$app/branches", labelKey: "appNav.branches", icon: GitBranch, shortcut: "b" },
  { to: "/$org/apps/$app/env", labelKey: "appNav.env", icon: Lock, shortcut: "e" },
  { to: "/$org/apps/$app/settings", labelKey: "appNav.settings", icon: Settings, shortcut: "s" },
];

type AppSectionKey = `appNav.${"overview" | "analytics" | "code" | "logs" | "triggers" | "versions" | "branches" | "data" | "env" | "domains" | "settings"}`;

export function buildDot(state: string): string {
  if (state === "ready") return "bg-tag-green-solid";
  if (state === "failed") return "bg-tag-red-solid";
  if (state === "building" || state === "pending") return "bg-tag-yellow-solid";
  return "bg-tag-gray-solid";
}

// Sidebar is the library's glass rail: the org navigation on every page (an app's sections are its tab
// strip); instance admins also get the Instance group. Below md the library renders it as a sheet. `org` is null outside an org when the user has none.
export function Sidebar({ org }: { org: string | null }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isAdmin = useIsInstanceAdmin();
  const orgs = useOrgs();
  const { setPaletteOpen } = useShell();
  const { setOpenMobile, isMobile } = useSidebar();
  const { data: branding } = useBranding();
  const { t } = useTranslation(["shell", "common", "plans"]);
  const routes = useRouter().routesByPath as unknown as Record<string, unknown>;
  // The Apps list arrives with its own route.
  const hasAppsPage = "/$org/apps" in routes || "/$org/apps/" in routes;
  const close = () => setOpenMobile(false);

  const renderLink: RenderNavLink = ({ href, onClick, ...rest }) => (
    <Link
      {...(rest as object)}
      to={href as "/"}
      onClick={(e) => {
        onClick?.(e);
        close();
      }}
    />
  );

  const instance: GlassNavGroup[] = isAdmin
    ? [{ label: t("instance.title"), items: INSTANCE_SECTIONS.map((s) => ({ title: t(s.labelKey), url: s.to, icon: s.icon })) }]
    : [];
  const orgGroups: GlassNavGroup[] = org
    ? [
        {
          items: [
            { title: t("nav.overview"), url: `/${org}`, icon: LayoutDashboard, match: "exact" },
            ...(hasAppsPage ? [{ title: t("nav.apps"), url: `/${org}/apps`, icon: Boxes }] : []),
            { title: t("plans:nav"), url: `/${org}/settings/usage`, icon: Gauge },
          ],
        },
        {
          label: t("nav.organization"),
          items: [
            { title: t("nav.members"), url: `/${org}/settings/members`, icon: Users },
            { title: t("nav.tokens"), url: `/${org}/settings/tokens`, icon: KeyRound },
            { title: t("nav.alerts"), url: `/${org}/settings/alerts`, icon: BellRing },
            { title: t("nav.auditLog"), url: `/${org}/settings/audit`, icon: ScrollText },
            { title: t("nav.settings"), url: `/${org}/settings/general`, icon: Settings },
          ],
        },
      ]
    : [];

  const brand = (
    <div className="flex min-w-0 flex-col gap-1">
      <GlassBrand
        logo={<img src={branding?.icon_url ?? defaultIcon()} alt="" />}
        name={branding?.logo_light_url ? <BrandLogo branding={branding} className="h-6 max-w-[160px]" /> : productName(branding)}
        href={org ? `/${org}` : "/"}
        toggleLabel={t("sidebar.collapse")}
        renderLink={renderLink}
      />
      {branding && isBranded(branding) ? <span data-testid="sidebar-brand" className="sr-only">{productName(branding)}</span> : null}
      <div className="flex min-w-0 items-center">{org ? <OrgSwitcher org={org} /> : <NoOrgHeader pending={orgs.isPending} />}</div>
      {org ? (
        <button
          type="button"
          onClick={() => {
            close();
            setPaletteOpen(true);
          }}
          aria-label={t("sidebar.openCommandMenu")}
          className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-full border border-line bg-surface px-2 text-[13px] text-muted outline-none hover:border-line-strong focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:border-transparent group-data-[collapsible=icon]:bg-transparent"
        >
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <span className={cn("flex-1 truncate text-left", ICON_HIDDEN)}>{t("sidebar.search")}</span>
          {isMobile ? null : <Kbd className={ICON_HIDDEN}>{SHORTCUT_LABEL}</Kbd>}
        </button>
      ) : null}
    </div>
  );

  const footer = (
    <div className="flex min-w-0 flex-col gap-px">
      <div className={ICON_HIDDEN}>
        <UpdateNotice />
      </div>
      <Link to="/me/security" onClick={close} className={ROW} activeProps={ACTIVE} title={t("nav.accountSecurity")}>
        <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
        <span className={cn("truncate", ICON_HIDDEN)}>{t("nav.accountSecurity")}</span>
      </Link>
    </div>
  );

  const nav = [...orgGroups, ...instance];

  return (
    <GlassSidebar
      aria-label={t("sidebar.label")}
      role="navigation"
      sheetTitle={t("top.navigation")}
      sheetDescription={t("top.consoleNavigation")}
      brand={brand}
      footer={footer}
      nav={nav}
      pathname={pathname}
      renderLink={renderLink}
    >
      {org ? <ProjectTree org={org} onNavigate={close} /> : null}
    </GlassSidebar>
  );
}

// NoOrgHeader stands in for the org switcher while the org list loads or when there is none.
function NoOrgHeader({ pending }: { pending: boolean }) {
  const { t } = useTranslation(["shell", "common", "plans"]);
  return (
    <div className={cn("flex h-11 min-w-0 flex-1 items-center gap-2 px-1.5 text-sm", ICON_HIDDEN)}>
      {pending ? <Skeleton className="h-5 w-32" /> : <span className="truncate text-muted">{t("sidebar.noOrganization")}</span>}
    </div>
  );
}

function ProjectTree({ org, onNavigate }: { org: string; onNavigate: () => void }): ReactNode {
  const projects = useProjects(org);
  const apps = useApps(org);
  const gate = useCreateAppGate(org);
  const navigate = useNavigate();
  const { setPaletteOpen } = useShell();
  const orgs = useOrgs();
  const role = orgs.data?.find((o) => o.slug === org)?.role;
  const canCreateProject = role === "owner" || role === "admin";
  const [createOpen, setCreateOpen] = useState(false);
  const { t } = useTranslation(["shell", "common", "plans"]);

  function newApp(project: string) {
    onNavigate();
    void navigate({ to: "/$org/apps/new", params: { org }, search: { project } });
  }

  return (
    <SidebarGroup className={cn("py-0", ICON_HIDDEN)}>
      <div className="group/projects flex items-center pr-1">
        <p className={LABEL}>{t("nav.projects")}</p>
        <span className="ml-auto flex items-center gap-0.5 pt-3">
          <button
            type="button"
            aria-label={t("sidebar.searchProjectsAndApps")}
            title={t("sidebar.searchTitle")}
            onClick={() => {
              onNavigate();
              setPaletteOpen(true);
            }}
            className={cn(ROW_ACTION, "group-hover/projects:opacity-100")}
          >
            <Search className="size-3.5" aria-hidden="true" />
          </button>
          {canCreateProject ? (
            <button
              type="button"
              aria-label={t("sidebar.newProject")}
              title={t("sidebar.newProject")}
              onClick={() => setCreateOpen(true)}
              className={cn(ROW_ACTION, "group-hover/projects:opacity-100")}
            >
              <Plus className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </span>
      </div>
      {projects.isPending ? (
        <div className="flex flex-col gap-2 px-2 py-1" aria-busy="true">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ) : projects.isError ? (
        <div className="flex flex-col items-start gap-2 px-2 text-sm">
          <p className="text-muted">{t("sidebar.projectsFailed")}</p>
          <Button variant="secondary" size="sm" onClick={() => void projects.refetch()}>
            {t("common:retry")}
          </Button>
        </div>
      ) : (projects.data ?? []).length === 0 ? (
        <p className="px-2 py-1 text-[13px] text-muted">{t("sidebar.noProjects")}</p>
      ) : null}

      {(projects.data ?? []).map((p, i) => {
        const own = (apps.data ?? []).filter((a) => a.project === p.slug);
        const canCreate = gate.inProject(p.slug);
        return (
          <Collapsible key={p.slug} defaultOpen className="group/project flex flex-col gap-px">
            <div className="group relative flex items-center rounded-full">
              <Link to="/$org/projects/$p" params={{ org, p: p.slug }} onClick={onNavigate} className={cn(ROW, "flex-1 pr-20")} activeProps={ACTIVE}>
                <IconTile icon={FolderOpen} hue={PROJECT_HUES[i % PROJECT_HUES.length]} size="xs" />
                <span className="truncate">{p.name}</span>
              </Link>
              <div className="absolute right-1 flex items-center gap-0.5">
                <DropdownMenu>
                  <DropdownMenuTrigger aria-label={t("sidebar.moreFor", { name: p.name })} className={ROW_ACTION}>
                    <MoreHorizontal className="size-4" aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem
                      onSelect={() => {
                        onNavigate();
                        void navigate({ to: "/$org/projects/$p", params: { org, p: p.slug } });
                      }}
                    >
                      <FolderOpen aria-hidden="true" /> {t("sidebar.openProject")}
                    </DropdownMenuItem>
                    {canCreate ? (
                      <DropdownMenuItem onSelect={() => newApp(p.slug)}>
                        <Plus aria-hidden="true" /> {t("sidebar.newApp")}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
                {canCreate ? (
                  <button
                    type="button"
                    aria-label={t("sidebar.newAppIn", { name: p.name })}
                    title={t("sidebar.newApp")}
                    onClick={() => newApp(p.slug)}
                    className={ROW_ACTION}
                  >
                    <Plus className="size-4" aria-hidden="true" />
                  </button>
                ) : null}
                <CollapsibleTrigger aria-label={p.name} className="grid size-6 cursor-pointer place-items-center rounded-md text-muted outline-none hover:bg-active hover:text-text focus-visible:ring-2 focus-visible:ring-focus">
                  <ChevronRight className="size-3.5 transition-transform group-data-[state=open]/project:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
                </CollapsibleTrigger>
              </div>
            </div>
            <CollapsibleContent>
              <ul className="ml-[17px] flex max-h-48 flex-col gap-px overflow-y-auto border-l border-line pl-1.5">
                {own.map((a) => (
                  <li key={`${a.project}/${a.slug}`}>
                    <Link
                      to="/$org/apps/$app"
                      params={{ org, app: a.slug }}
                      onClick={onNavigate}
                      className={cn(ROW, "h-7 text-muted hover:text-text")}
                      activeProps={{ className: "bg-sidebar-accent font-medium text-text hover:bg-sidebar-accent" }}
                    >
                      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", buildDot(a.status.build_state))} />
                      <span className="truncate">{a.name ?? a.slug}</span>
                    </Link>
                  </li>
                ))}
                {apps.isSuccess && own.length === 0 ? <li className="px-2 py-1 text-[12px] text-muted">{t("sidebar.noAppsYet")}</li> : null}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
      {canCreateProject ? <CreateProjectDialog org={org} open={createOpen} onOpenChange={setCreateOpen} /> : null}
    </SidebarGroup>
  );
}
