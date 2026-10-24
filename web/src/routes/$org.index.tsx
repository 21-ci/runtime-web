import { House as HomeTile } from "lucide-react";
import { IconTile } from "@/components/ui/icon-tile";
import { Link, createFileRoute } from "@tanstack/react-router";

import { Dashboard } from "@/components/features/overview/dashboard";
import { NoProjects } from "@/components/features/empty/no-projects";
import { QueryError } from "@/components/features/empty/query-error";
import { QuotaBar } from "@/components/features/org/quota-bar";
import { UsageCard } from "@/components/features/org/usage-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrgs, useProjects } from "@/hooks/orgs";

export const Route = createFileRoute("/$org/")({
  component: OrgOverview,
});

function OrgOverview() {
  const { org } = Route.useParams();
  const orgs = useOrgs();
  const projects = useProjects(org);
  const role = orgs.data?.find((o) => o.slug === org)?.role;
  const canSeeUsage = role === "owner" || role === "admin";

  return (
    <div className="flex flex-col gap-6">
      <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-[-0.01em]">
        <IconTile icon={HomeTile} entity="overview" size="md" />
        Overview
      </h1>
      <Dashboard org={org} role={role} />
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="min-w-0">
        <section aria-labelledby="projects-heading" className="flex flex-col gap-3">
          <h2 id="projects-heading" className="text-sm font-semibold">
            Projects
          </h2>
          {projects.isError ? (
            <QueryError
              error={projects.error}
              onRetry={() => void projects.refetch()}
              notFoundTitle="Organization not found"
            />
          ) : projects.isPending ? (
            <div className="grid min-h-[120px] gap-3 sm:grid-cols-2" aria-busy="true">
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
          ) : (projects.data ?? []).length === 0 ? (
            <NoProjects org={org} />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {(projects.data ?? []).map((p) => (
                <li key={p.slug}>
                  <Link
                    to="/$org/projects/$p"
                    params={{ org, p: p.slug }}
                    className="block rounded-xl border border-line bg-surface p-4 transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-card"
                  >
                    <span className="block font-semibold">{p.name}</span>
                    <span className="mt-1 block text-sm text-muted">{p.environments.join(", ")}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="flex flex-col gap-4">
        <QuotaBar org={org} />
        <UsageCard org={org} enabled={canSeeUsage} />
      </div>
      </div>
    </div>
  );
}
