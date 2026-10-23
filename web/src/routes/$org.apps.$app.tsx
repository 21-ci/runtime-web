import { Link, Outlet, createFileRoute } from "@tanstack/react-router";

import { QueryError } from "@/components/features/empty/query-error";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useApps } from "@/hooks/orgs";

export const Route = createFileRoute("/$org/apps/$app")({
  component: AppPage,
});

// AppPage is the app header. The tabs (settings, versions, logs) arrive with later tasks.
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
      <header>
        <p className="text-sm text-muted">
          <Link to="/$org/projects/$p" params={{ org, p: a.project }} className="hover:underline">
            {a.project}
          </Link>
          {" / "}
          {a.environment}
        </p>
        <h1 className="text-xl font-semibold">{a.name ?? a.slug}</h1>
      </header>
      <dl className="grid max-w-md grid-cols-2 gap-2 text-sm">
        <dt className="text-muted">Build</dt>
        <dd>{a.status.build_state}</dd>
        <dt className="text-muted">Live version</dt>
        <dd>{a.live_version ?? "none"}</dd>
      </dl>
      <nav aria-label="App sections" className="flex gap-3 text-sm">
        <Link to="/$org/apps/$app/versions" params={{ org, app }} className="hover:underline">
          Versions
        </Link>
        <Link to="/$org/apps/$app/logs" params={{ org, app }} className="hover:underline">
          Logs
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}
