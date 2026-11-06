import { Link, createFileRoute } from "@tanstack/react-router";
import { Boxes, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { QueryError } from "@/components/features/empty/query-error";
import { parseAppFilters } from "@/components/features/overview/apps-filter";
import { AppsBrowser } from "@/components/features/overview/apps-table";
import { useCreateAppGate } from "@/components/layout/create-app-gate";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { useApps, useProjects } from "@/hooks/orgs";

export const Route = createFileRoute("/$org/apps/")({
  validateSearch: parseAppFilters,
  component: AppsPage,
});

function AppsPage() {
  const { t } = useTranslation("overview");
  const { org } = Route.useParams();
  const filters = Route.useSearch();
  const navigate = Route.useNavigate();
  const apps = useApps(org);
  const projects = useProjects(org);
  const gate = useCreateAppGate(org);
  const newApp = gate.any ? (
    <Button asChild>
      <Link to="/$org/apps/new" params={{ org }}>
        <Plus aria-hidden="true" /> {t("apps.new")}
      </Link>
    </Button>
  ) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader icon={Boxes} entity="apps" title={t("apps.title")} description={t("apps.description")} actions={newApp} />
      {apps.isError ? (
        <QueryError error={apps.error} onRetry={() => void apps.refetch()} notFoundTitle={t("projects.notFound")} />
      ) : !apps.isPending && apps.data.length === 0 ? (
        <EmptyState entity="apps" icon={Boxes} title={t("apps.emptyTitle")} description={t("apps.emptyDescription")} />
      ) : (
        <AppsBrowser
          org={org}
          name={`${org}-apps`}
          apps={apps.data ?? []}
          projects={projects.data}
          filters={filters}
          loading={apps.isPending}
          onFiltersChange={(next) => void navigate({ search: next, replace: true })}
        />
      )}
    </div>
  );
}
