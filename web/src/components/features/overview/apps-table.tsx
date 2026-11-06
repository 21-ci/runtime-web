import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { ExportMenu } from "@/components/ui/export-menu";
import { EntityTile } from "@/components/ui/icon-tile";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AppSummary, Project } from "@/hooks/orgs";

import { filterApps, type AppFilters } from "./apps-filter";

const BUILD_VARIANT: Record<string, "success" | "danger" | "warning" | "default"> = {
  ready: "success",
  failed: "danger",
  building: "warning",
  pending: "warning",
};
const BUILD_KEY = {
  ready: "build.ready",
  failed: "build.failed",
  building: "build.building",
  pending: "build.pending",
} as const;
const STATES = ["ready", "building", "pending", "failed"] as const;
const ALL = "*";

/** The app's state as a word; a state this console does not know reads as it is. */
export function BuildBadge({ state }: { state: string }) {
  const { t } = useTranslation("overview");
  const key = BUILD_KEY[state as keyof typeof BUILD_KEY];
  return (
    <Badge variant={BUILD_VARIANT[state] ?? "default"} dot>
      {key ? t(key) : state}
    </Badge>
  );
}

function useColumns(org: string, projects: readonly Project[] | undefined, hideProject: boolean): DataColumn<AppSummary>[] {
  const { t } = useTranslation("overview");
  const projectName = (slug: string) => projects?.find((p) => p.slug === slug)?.name ?? slug;
  const label = (a: AppSummary) => a.name ?? a.slug;
  return [
    {
      key: "name",
      header: t("appsTable.app"),
      primary: true,
      sortValue: label,
      cell: (a) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <EntityTile kind="app" name={a.slug} />
          <Link to="/$org/apps/$app" params={{ org, app: a.slug }} className="min-w-0 truncate font-medium text-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus">
            {label(a)}
          </Link>
        </span>
      ),
    },
    ...(hideProject
      ? []
      : [{ key: "project", header: t("appsTable.project"), sortValue: (a: AppSummary) => projectName(a.project), title: (a: AppSummary) => projectName(a.project), cell: (a: AppSummary) => projectName(a.project) }]),
    { key: "environment", header: t("appsTable.environment"), sortValue: (a) => a.environment, title: (a) => a.environment, cell: (a) => a.environment },
    { key: "state", header: t("appsTable.state"), sortValue: (a) => a.status.build_state, title: (a) => a.status.last_error ?? "", cell: (a) => <BuildBadge state={a.status.build_state} /> },
    {
      key: "live",
      header: t("appsTable.live"),
      align: "right",
      sortValue: (a) => a.live_version ?? -1,
      cell: (a) => (a.live_version !== null ? `v${a.live_version}` : <span className="text-muted">{t("appsTable.notLive")}</span>),
    },
  ];
}

// AppsTable is the one table of apps: the org overview, the Apps page and a project page all show it.
export function AppsTable({
  org,
  apps,
  projects,
  hideProject = false,
  pageSize,
  count,
  toolbar,
  loading = false,
  empty,
}: {
  org: string;
  apps: readonly AppSummary[];
  projects: readonly Project[] | undefined;
  hideProject?: boolean;
  pageSize?: number;
  count?: ReactNode;
  toolbar?: ReactNode;
  loading?: boolean;
  empty?: ReactNode;
}) {
  const { t } = useTranslation("overview");
  const columns = useColumns(org, projects, hideProject);
  return (
    <DataTable
      label={t("apps.title")}
      columns={columns}
      rows={apps}
      rowKey={(a) => `${a.project}/${a.slug}`}
      loading={loading}
      {...(pageSize !== undefined ? { pageSize } : {})}
      {...(count != null ? { count } : {})}
      {...(toolbar != null ? { toolbar } : {})}
      {...(empty != null ? { empty } : {})}
    />
  );
}

function FilterSelect({ label, value, onChange, options, all }: { label: string; value: string | undefined; onChange: (v: string | undefined) => void; options: readonly { value: string; label: string }[]; all: string }) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
      <SelectTrigger aria-label={label} className="h-8 w-auto gap-1.5 px-2.5 text-[13px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{all}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// AppsBrowser adds the filter row and the export. The caller keeps the filters, in the URL, so a view can be shared.
export function AppsBrowser({
  org,
  name,
  apps,
  projects,
  filters,
  onFiltersChange,
  hideProject = false,
  loading = false,
}: {
  org: string;
  /** The export file's name, without the extension. */
  name: string;
  apps: readonly AppSummary[];
  projects: readonly Project[] | undefined;
  filters: AppFilters;
  onFiltersChange: (next: AppFilters) => void;
  hideProject?: boolean;
  loading?: boolean;
}) {
  const { t } = useTranslation("overview");
  const shown = filterApps(apps, filters);
  const set = (key: keyof AppFilters) => (value: string | undefined) => {
    const rest = { ...filters };
    delete rest[key];
    onFiltersChange(value ? { ...rest, [key]: value } : rest);
  };
  const environments = [...new Set(apps.map((a) => a.environment))].sort();
  const toolbar = (
    <>
      <Input
        aria-label={t("appsTable.filter")}
        placeholder={t("appsTable.filter")}
        value={filters.q ?? ""}
        onChange={(e) => set("q")(e.target.value || undefined)}
        className="h-8 w-44 max-md:w-full"
      />
      {hideProject ? null : (
        <FilterSelect label={t("apps.filter")} value={filters.project} onChange={set("project")} all={t("apps.allProjects")} options={(projects ?? []).map((p) => ({ value: p.slug, label: p.name }))} />
      )}
      <FilterSelect label={t("appsTable.environmentFilter")} value={filters.environment} onChange={set("environment")} all={t("appsTable.allEnvironments")} options={environments.map((e) => ({ value: e, label: e }))} />
      <FilterSelect label={t("appsTable.stateFilter")} value={filters.state} onChange={set("state")} all={t("appsTable.allStates")} options={STATES.map((s) => ({ value: s, label: t(BUILD_KEY[s]) }))} />
      <ExportMenu
        name={name}
        rows={shown.map((a) => ({ app: a.slug, name: a.name, project: a.project, environment: a.environment, state: a.status.build_state, live_version: a.live_version }))}
      />
    </>
  );
  return (
    <AppsTable
      org={org}
      apps={shown}
      projects={projects}
      hideProject={hideProject}
      loading={loading}
      toolbar={toolbar}
      count={shown.length === apps.length ? t("appsTable.count", { count: apps.length }) : t("appsTable.countOf", { shown: shown.length, count: apps.length })}
      empty={<EmptyState variant="no-range" title={t("appsTable.noMatch")} />}
    />
  );
}
