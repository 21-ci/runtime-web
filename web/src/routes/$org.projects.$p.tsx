import { FolderOpen, Plus } from "lucide-react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { NoApps } from "@/components/features/empty/no-apps";
import { QueryError } from "@/components/features/empty/query-error";
import { parseAppFilters } from "@/components/features/overview/apps-filter";
import { AppsBrowser } from "@/components/features/overview/apps-table";
import { useCreateAppGate } from "@/components/layout/create-app-gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useApps, useEnvironments, useProjects } from "@/hooks/orgs";

export const Route = createFileRoute("/$org/projects/$p")({
  validateSearch: parseAppFilters,
  component: ProjectPage,
});

function ProjectPage() {
  const { t } = useTranslation(["apps", "common"]);
  const { org, p } = Route.useParams();
  const filters = Route.useSearch();
  const navigate = Route.useNavigate();
  const projects = useProjects(org);
  const envs = useEnvironments(org, p);
  const apps = useApps(org, p);
  const gate = useCreateAppGate(org);
  const project = projects.data?.find((x) => x.slug === p);

  if (projects.isError) {
    return (
      <QueryError
        error={projects.error}
        onRetry={() => void projects.refetch()}
        notFoundTitle={t("project.notFound")}
        notFoundDescription={t("notFound.description")}
      />
    );
  }
  if (projects.isPending) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (!project) {
    return <EmptyState title={t("project.notFound")} description={t("notFound.description")} />;
  }
  if (apps.isError) {
    return <QueryError error={apps.error} onRetry={() => void apps.refetch()} notFoundTitle={t("project.appsNotFound")} />;
  }

  const list = apps.data ?? [];
  const canCreate = gate.inProject(p);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={FolderOpen}
        entity="projects"
        title={project.name}
        description={
          <span className="flex flex-wrap items-center gap-1.5" aria-label={t("project.environmentsLabel")}>
            <span>{t("project.environments")}</span>
            {(envs.data ?? project.environments).map((e) => (
              <Badge key={e} variant="outline">
                {e}
              </Badge>
            ))}
          </span>
        }
        actions={
          canCreate && list.length > 0 ? (
            <Button asChild variant="default">
              <Link to="/$org/apps/new" params={{ org }} search={{ project: p }}>
                <Plus aria-hidden="true" /> {t("project.newApp")}
              </Link>
            </Button>
          ) : null
        }
      />

      {!apps.isPending && list.length === 0 ? (
        <NoApps org={org} project={p} />
      ) : (
        <AppsBrowser
          org={org}
          name={`${org}-${p}-apps`}
          apps={list}
          projects={projects.data}
          filters={filters}
          hideProject
          loading={apps.isPending}
          onFiltersChange={(next) => void navigate({ search: next, replace: true })}
        />
      )}
    </div>
  );
}
