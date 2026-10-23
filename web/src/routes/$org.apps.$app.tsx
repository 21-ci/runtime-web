import { createFileRoute, Outlet } from "@tanstack/react-router";

import { AppHeader } from "@/components/features/app-header/app-header";
import { QueryError } from "@/components/features/empty/query-error";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useApps } from "@/hooks/orgs";

export const Route = createFileRoute("/$org/apps/$app")({
  component: AppPage,
});

// AppPage renders the app header (status pill, tabs) above the active sub-page.
function AppPage() {
  const { org, app } = Route.useParams();
  const apps = useApps(org);

  if (apps.isError) {
    return (
      <QueryError
        error={apps.error}
        onRetry={() => void apps.refetch()}
        notFoundTitle="App not found"
        notFoundDescription="It may have been deleted or you lack access."
      />
    );
  }
  if (apps.isPending) return <Skeleton className="h-32 w-full" />;
  const a = apps.data?.find((x) => x.slug === app);
  if (!a) {
    return <EmptyState title="App not found" description="It may have been deleted or you lack access." />;
  }

  return (
    <div className="flex flex-col gap-4">
      <AppHeader org={org} app={a} />
      <Outlet />
    </div>
  );
}
