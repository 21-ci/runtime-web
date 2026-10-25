import { FolderOpen, Plus } from "lucide-react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { NoApps } from "@/components/features/empty/no-apps";
import { QueryError } from "@/components/features/empty/query-error";
import { useCreateAppGate } from "@/components/layout/create-app-gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LetterTile, hueFor } from "@/components/ui/icon-tile";
import { PageHeader } from "@/components/ui/page-header";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useApps, useEnvironments, useProjects } from "@/hooks/orgs";

export const Route = createFileRoute("/$org/projects/$p")({
  component: ProjectPage,
});

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

function ProjectPage() {
  const { t } = useTranslation(["apps", "common"]);
  const { org, p } = Route.useParams();
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

      {apps.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : list.length === 0 ? (
        <NoApps org={org} project={p} />
      ) : (
        <SectionCard title={t("project.apps")} description={t("project.appsInProject", { count: list.length })} flush>
          <ul className="divide-y divide-line">
            {list.map((a) => (
              <li key={a.slug}>
                <Link
                  to="/$org/apps/$app"
                  params={{ org, app: a.slug }}
                  className="flex h-12 items-center gap-3 px-5 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                >
                  <LetterTile label={a.name ?? a.slug} hue={hueFor(a.slug)} size="sm" solid />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{a.name ?? a.slug}</span>
                  <Badge variant="outline" className="hidden sm:inline-flex">
                    {a.environment}
                  </Badge>
                  <Badge variant={BUILD_VARIANT[a.status.build_state] ?? "default"} dot>
                    {BUILD_KEY[a.status.build_state as keyof typeof BUILD_KEY]
                      ? t(BUILD_KEY[a.status.build_state as keyof typeof BUILD_KEY])
                      : a.status.build_state}
                  </Badge>
                  <span className="hidden w-12 text-right text-[12px] tabular-nums text-muted sm:inline">
                    {a.live_version !== null ? `v${a.live_version}` : "-"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}
