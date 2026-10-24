import { Link, createFileRoute } from "@tanstack/react-router";

import { NoApps } from "@/components/features/empty/no-apps";
import { QueryError } from "@/components/features/empty/query-error";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useApps, useEnvironments, useProjects } from "@/hooks/orgs";

export const Route = createFileRoute("/$org/projects/$p")({
  component: ProjectPage,
});

function ProjectPage() {
  const { org, p } = Route.useParams();
  const projects = useProjects(org);
  const envs = useEnvironments(org, p);
  const apps = useApps(org, p);
  const project = projects.data?.find((x) => x.slug === p);

  if (projects.isError) {
    return (
      <QueryError
        error={projects.error}
        onRetry={() => void projects.refetch()}
        notFoundTitle="Project not found"
        notFoundDescription="It may have been deleted or you lack access."
      />
    );
  }
  if (projects.isPending) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (!project) {
    return <EmptyState title="Project not found" description="It may have been deleted or you lack access." />;
  }
  if (apps.isError) {
    return (
      <QueryError error={apps.error} onRetry={() => void apps.refetch()} notFoundTitle="Apps not found" />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold">{project.name}</h1>
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Environments">
          {(envs.data ?? project.environments).map((e) => (
            <li key={e} className="rounded-full border border-line bg-panel px-2.5 py-0.5 text-xs">
              {e}
            </li>
          ))}
        </ul>
      </header>

      <section aria-labelledby="apps-heading" className="flex flex-col gap-3">
        <h2 id="apps-heading" className="text-sm font-semibold">
          Apps
        </h2>
        {apps.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : (apps.data ?? []).length === 0 ? (
          <NoApps org={org} project={p} />
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line bg-surface">
            {(apps.data ?? []).map((a) => (
              <li key={a.slug}>
                <Link
                  to="/$org/apps/$app"
                  params={{ org, app: a.slug }}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-panel-2"
                >
                  <span className="font-medium">{a.name ?? a.slug}</span>
                  <span className="text-sm text-muted">
                    {a.environment} · {a.status.build_state}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
