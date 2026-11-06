import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { PageBody } from "@/components/layout/app-shell";

import { DeploymentsView } from "@/components/features/deployments/deployments-view";
import { parseFilters, type DeploymentFilters } from "@/components/features/deployments/history";

export const Route = createFileRoute("/$org/apps/$app/deployments")({
  validateSearch: (search: Record<string, unknown>): Partial<DeploymentFilters> => parseFilters(search),
  component: AppDeploymentsPage,
});

function AppDeploymentsPage() {
  const { org, app } = Route.useParams();
  const filters = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <PageBody>
      <DeploymentsView org={org} app={app} filters={filters} onFiltersChange={(next) => void navigate({ search: next, replace: true })} />
    </PageBody>
  );
}
