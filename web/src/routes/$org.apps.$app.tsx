import { createFileRoute, Outlet } from "@tanstack/react-router";

import { AppTabs } from "@/components/features/app-header/app-header";
import { QueryError } from "@/components/features/empty/query-error";
import { PageBody } from "@/components/layout/app-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useApps } from "@/hooks/orgs";

export const Route = createFileRoute("/$org/apps/$app")({
  staticData: { fullBleed: true },
  component: AppPage,
});

// AppPage frames every app sub-page: the sidebar carries the app navigation on md+ and AppTabs
// renders the same sections as a tab strip below md. Sub-pages decide their own width through
// their route's staticData.fullBleed.
function AppPage() {
  const { org, app } = Route.useParams();
  const apps = useApps(org);

  if (apps.isError) {
    return (
      <PageBody>
        <QueryError
          error={apps.error}
          onRetry={() => void apps.refetch()}
          notFoundTitle="App not found"
          notFoundDescription="It may have been deleted or you lack access."
        />
      </PageBody>
    );
  }
  if (apps.isPending) {
    return (
      <PageBody>
        <Skeleton className="h-32 w-full" />
      </PageBody>
    );
  }
  const a = apps.data?.find((x) => x.slug === app);
  if (!a) {
    return (
      <PageBody>
        <EmptyState title="App not found" description="It may have been deleted or you lack access." />
      </PageBody>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppTabs org={org} app={a} />
      <Outlet />
    </div>
  );
}
