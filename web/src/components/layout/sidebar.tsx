import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  Boxes,
  Building2,
  ChevronsLeft,
  Clock,
  Code2,
  Database,
  FolderOpen,
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

import { CreateProjectDialog } from "@/components/features/org/create-project-dialog";
import { useIsInstanceAdmin } from "@/components/features/admin/gate";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTile, LetterTile, hueFor, type Hue } from "@/components/ui/icon-tile";
import { Kbd } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useApps, useOrgs, useProjects, type AppSummary } from "@/hooks/orgs";
import { cn } from "@/lib/utils";
import { useCreateAppGate } from "./create-app-gate";
import { OrgSwitcher } from "./org-switcher";
import { SidebarBrand } from "@/components/features/branding/brand";
import { SHORTCUT_LABEL, useShell } from "./shell-context";

// PROJECT_HUES gives each project its own small solid tile.
const PROJECT_HUES: Hue[] = ["green", "blue", "pink", "yellow", "purple", "teal", "orange"];

// ROW is a 28px sidebar row; ACTIVE is the current page (a wash plus medium weight).
export const ROW =
  "flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-text outline-none transition-[background-color,color] duration-[120ms] ease-ui hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus";
export const ACTIVE = { className: "bg-active font-medium hover:bg-active" };
export const ROW_ACTION =
  "grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted transition-opacity opacity-0 outline-none hover:bg-active hover:text-text focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-focus group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100";

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("px-2 pb-1 pt-4 text-[11px] font-semibold text-muted", className)}>{children}</p>;
}

export function NavLink({
  to,
  params,
  icon: Icon,
  label,
  onNavigate,
  exact,
  badge,
}: {
  to: string;
  params?: Record<string, string>;
  icon: LucideIcon;
  label: string;
  onNavigate?: () => void;
  exact?: boolean;
  badge?: ReactNode;
}) {
  return (
    <Link to={to} params={params} onClick={onNavigate} activeOptions={{ exact }} className={ROW} activeProps={ACTIVE}>
      <Icon className="size-4 shrink-0 text-muted" aria-hidden="true" />
      <span className="truncate">{label}</span>
      {badge ? <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted">{badge}</span> : null}
    </Link>
  );
}

// SidebarFrame is the shared chrome: org switcher, collapse, search, then the body and footer.
export function SidebarFrame({
  top,
  footer,
  onCollapse,
  onSearch,
  label,
  brand,
  children,
}: {
  top: ReactNode;
  /** Optional instance brand row above the header. */
  brand?: ReactNode;
  footer?: ReactNode;
  onCollapse?: () => void;
  onSearch?: () => void;
  label?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation(["shell", "common"]);
  return (
    <nav aria-label={label ?? t("sidebar.label")} className="flex min-h-full flex-col gap-0.5 px-2.5 py-2.5">
      {brand}
      <div className="group flex items-center gap-1">
        {top}
        {onCollapse ? (
          <button
            type="button"
            aria-label={t("sidebar.collapse")}
            title={t("sidebar.collapseTitle")}
            onClick={onCollapse}
            className={ROW_ACTION}
          >
            <ChevronsLeft className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {onSearch ? (
        <button
          type="button"
          onClick={onSearch}
          aria-label={t("sidebar.openCommandMenu")}
          className="mb-1 mt-2 flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface shadow-card-2 px-2 text-[13px] text-muted shadow-card outline-none transition-[border-color,box-shadow] duration-[140ms] hover:border-line-strong focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1 text-left">{t("sidebar.search")}</span>
          <Kbd>{SHORTCUT_LABEL}</Kbd>
        </button>
      ) : null}

      {children}

      {footer ? <div className="mt-auto flex flex-col gap-px border-t border-line pt-2">{footer}</div> : null}
    </nav>
  );
}

// INSTANCE_SECTIONS are the instance-admin pages. They form the Instance group of the normal
// sidebar, shown only to instance admins (the API authorizes every admin call regardless).
// labelKey is a key in the `shell` namespace.
export const INSTANCE_SECTIONS = [
  { to: "/admin/users", labelKey: "instance.users", icon: Users },
  { to: "/admin/orgs", labelKey: "instance.organizations", icon: Building2 },
  { to: "/admin/audit", labelKey: "instance.auditLog", icon: ScrollText },
  { to: "/admin/node", labelKey: "instance.node", icon: Server },
  { to: "/admin/cache", labelKey: "instance.cache", icon: Database },
  { to: "/admin/domains", labelKey: "instance.domains", icon: Globe },
  { to: "/admin/settings", labelKey: "instance.settings", icon: Settings },
] as const satisfies readonly { to: string; labelKey: string; icon: LucideIcon }[];

// Sidebar switches between the org navigation and, on an app page, the app's own navigation
// (val.town model). Instance admins also get the Instance group under the org navigation. It
// renders in the fixed column (md+, where onCollapse is set) and inside the mobile sheet. `org` is
// null outside an org when the user has none (or while the org list loads on an admin page).
export function Sidebar({
  org,
  onNavigate,
  onCollapse,
}: {
  org: string | null;
  onNavigate?: () => void;
  onCollapse?: () => void;
}) {
  const params = useParams({ strict: false }) as { app?: string };
  const isAdmin = useIsInstanceAdmin();
  const { setPaletteOpen } = useShell();
  const orgs = useOrgs();
  const appSlug = params.app && params.app !== "new" ? params.app : undefined;
  const { t } = useTranslation(["shell", "common"]);

  const footer = <NavLink to="/me/security" icon={ShieldCheck} label={t("nav.accountSecurity")} onNavigate={onNavigate} />;

  return (
    <SidebarFrame
      brand={<SidebarBrand />}
      top={org ? <OrgSwitcher org={org} /> : <NoOrgHeader pending={orgs.isPending} />}
      onCollapse={onCollapse}
      onSearch={
        org
          ? () => {
              onNavigate?.();
              setPaletteOpen(true);
            }
          : undefined
      }
      footer={footer}
    >
      {org && appSlug ? (
        <AppNav org={org} slug={appSlug} onNavigate={onNavigate} />
      ) : (
        <>
          {org ? <OrgNav org={org} onNavigate={onNavigate} /> : null}
          {isAdmin ? <InstanceNav onNavigate={onNavigate} /> : null}
        </>
      )}
    </SidebarFrame>
  );
}

// NoOrgHeader stands in for the org switcher while the org list loads or when there is none.
function NoOrgHeader({ pending }: { pending: boolean }) {
  const { t } = useTranslation(["shell", "common"]);
  return (
    <div className="flex h-9 min-w-0 flex-1 items-center gap-2 px-1.5 text-sm">
      {pending ? (
        <Skeleton className="h-5 w-32" />
      ) : (
        <span className="truncate text-muted">{t("sidebar.noOrganization")}</span>
      )}
    </div>
  );
}

function InstanceNav({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation(["shell", "common"]);
  return (
    <div role="group" aria-labelledby="sidebar-instance" className="flex flex-col gap-px">
      <SectionLabel>
        <span id="sidebar-instance">{t("instance.title")}</span>
      </SectionLabel>
      {INSTANCE_SECTIONS.map((s) => (
        <NavLink key={s.to} to={s.to} icon={s.icon} label={t(s.labelKey)} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

function OrgNav({ org, onNavigate }: { org: string; onNavigate?: () => void }) {
  const projects = useProjects(org);
  const apps = useApps(org);
  const gate = useCreateAppGate(org);
  const navigate = useNavigate();
  const { setPaletteOpen } = useShell();
  const orgs = useOrgs();
  const role = orgs.data?.find((o) => o.slug === org)?.role;
  const canCreateProject = role === "owner" || role === "admin";
  const [createOpen, setCreateOpen] = useState(false);
  const { t } = useTranslation(["shell", "common"]);

  function newApp(project: string) {
    onNavigate?.();
    void navigate({ to: "/$org/apps/new", params: { org }, search: { project } });
  }

  return (
    <>
      <div className="flex flex-col gap-px">
        <NavLink to="/$org" params={{ org }} icon={LayoutDashboard} label={t("nav.overview")} onNavigate={onNavigate} exact />
        <NavLink to="/$org/settings/members" params={{ org }} icon={Users} label={t("nav.members")} onNavigate={onNavigate} />
        <NavLink to="/$org/settings/tokens" params={{ org }} icon={KeyRound} label={t("nav.tokens")} onNavigate={onNavigate} />
        <NavLink to="/$org/settings/audit" params={{ org }} icon={ScrollText} label={t("nav.auditLog")} onNavigate={onNavigate} />
        <NavLink to="/$org/settings/general" params={{ org }} icon={Settings} label={t("nav.settings")} onNavigate={onNavigate} />
      </div>

      <div className="group/projects flex items-center pr-1">
        <SectionLabel>{t("nav.projects")}</SectionLabel>
        <span className="ml-auto flex items-center gap-0.5 pt-3">
          <button
            type="button"
            aria-label={t("sidebar.searchProjectsAndApps")}
            title={t("sidebar.searchTitle")}
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
          <div key={p.slug} className="flex flex-col gap-px">
            <div className="group relative flex items-center rounded-md">
              <Link
                to="/$org/projects/$p"
                params={{ org, p: p.slug }}
                onClick={onNavigate}
                className={cn(ROW, "flex-1 pr-14")}
                activeProps={ACTIVE}
              >
                <IconTile icon={FolderOpen} hue={PROJECT_HUES[i % PROJECT_HUES.length]} size="xs" solid />
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
                        onNavigate?.();
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
              </div>
            </div>
            <ul className="flex flex-col gap-px">
              {own.map((a) => (
                <li key={`${a.project}/${a.slug}`}>
                  <Link
                    to="/$org/apps/$app"
                    params={{ org, app: a.slug }}
                    onClick={onNavigate}
                    className={cn(ROW, "pl-[26px] text-muted hover:text-text")}
                    activeProps={{ className: "bg-active font-medium text-text hover:bg-active" }}
                  >
                    <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", buildDot(a.status.build_state))} />
                    <span className="truncate">{a.name ?? a.slug}</span>
                  </Link>
                </li>
              ))}
              {apps.isSuccess && own.length === 0 ? (
                <li className="py-1 pl-[26px] pr-2 text-[12px] text-muted">{t("sidebar.noAppsYet")}</li>
              ) : null}
            </ul>
          </div>
        );
      })}
      {canCreateProject ? <CreateProjectDialog org={org} open={createOpen} onOpenChange={setCreateOpen} /> : null}
    </>
  );
}

export function buildDot(state: string): string {
  if (state === "ready") return "bg-tag-green-solid";
  if (state === "failed") return "bg-tag-red-solid";
  if (state === "building" || state === "pending") return "bg-tag-yellow-solid";
  return "bg-tag-gray-solid";
}

// APP_SECTIONS is the app navigation (sidebar on md+, tab strip below). Overview is exact.
// labelKey is a key in the `shell` namespace.
export const APP_SECTIONS: readonly { to: string; labelKey: AppSectionKey; icon: LucideIcon; exact?: boolean }[] = [
  { to: "/$org/apps/$app", labelKey: "appNav.overview", icon: LayoutDashboard, exact: true },
  { to: "/$org/apps/$app/code", labelKey: "appNav.code", icon: Code2 },
  { to: "/$org/apps/$app/logs", labelKey: "appNav.logs", icon: ScrollText },
  { to: "/$org/apps/$app/triggers", labelKey: "appNav.triggers", icon: Clock },
  { to: "/$org/apps/$app/versions", labelKey: "appNav.versions", icon: History },
  { to: "/$org/apps/$app/env", labelKey: "appNav.env", icon: Lock },
  { to: "/$org/apps/$app/domains", labelKey: "appNav.domains", icon: Globe },
  { to: "/$org/apps/$app/settings", labelKey: "appNav.settings", icon: Settings },
];

type AppSectionKey = `appNav.${"overview" | "code" | "logs" | "triggers" | "versions" | "env" | "domains" | "settings"}`;

function AppNav({ org, slug, onNavigate }: { org: string; slug: string; onNavigate?: () => void }) {
  const apps = useApps(org);
  const app: AppSummary | undefined = (apps.data ?? []).find((a) => a.slug === slug);
  const pending = apps.isPending;
  const projects = useProjects(org);
  const name = app?.name ?? slug;
  const projectName = app ? (projects.data?.find((p) => p.slug === app.project)?.name ?? app.project) : undefined;
  const { t } = useTranslation(["shell", "common"]);

  return (
    <>
      <Link to="/$org" params={{ org }} onClick={onNavigate} className={cn(ROW, "text-muted hover:text-text")}>
        <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{t("nav.allProjects")}</span>
      </Link>

      <div className="mb-1 mt-2 flex items-center gap-2.5 rounded-lg px-1.5 py-1.5">
        {pending && !app ? (
          <Skeleton className="size-9 rounded-lg" />
        ) : (
          <LetterTile label={name} hue={hueFor(slug)} size="md" solid className="size-9 rounded-lg text-base" />
        )}
        <div className="min-w-0">
          <p className="truncate text-[12px] leading-tight text-muted">
            {projectName ? (
              <Link to="/$org/projects/$p" params={{ org, p: app!.project }} onClick={onNavigate} className="hover:underline">
                {projectName}
              </Link>
            ) : (
              t("nav.app")
            )}
          </p>
          <p className="truncate text-sm font-semibold leading-tight">{name}</p>
        </div>
      </div>

      <div className="flex flex-col gap-px" aria-label={t("nav.appNavigation")} role="group">
        {APP_SECTIONS.map((s) => (
          <NavLink key={s.to} to={s.to} params={{ org, app: slug }} icon={s.icon} label={t(s.labelKey)} exact={s.exact} onNavigate={onNavigate} />
        ))}
      </div>

      <SectionLabel>{t("nav.project")}</SectionLabel>
      <NavLink to="/$org/projects/$p" params={{ org, p: app?.project ?? "" }} icon={Boxes} label={t("nav.allAppsInProject")} onNavigate={onNavigate} />
    </>
  );
}
