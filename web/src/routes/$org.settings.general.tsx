import { createFileRoute } from "@tanstack/react-router";

import { QuotaBar } from "@/components/features/org/quota-bar";
import { useOrgs } from "@/hooks/orgs";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/$org/settings/general")({
  component: GeneralRoute,
});

// General shows the org's identity and its quota. Renaming and deleting are not in v1 UI.
function GeneralRoute() {
  const { org } = Route.useParams();
  const orgs = useOrgs();
  if (orgs.isPending) return <Skeleton className="h-40 w-full" />;
  const current = orgs.data?.find((o) => o.slug === org);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Organization settings</h1>
      <dl className="grid max-w-md grid-cols-2 gap-2 text-sm">
        <dt className="text-muted">Name</dt>
        <dd>{current?.name ?? org}</dd>
        <dt className="text-muted">Slug</dt>
        <dd className="font-mono">{org}</dd>
      </dl>
      <QuotaBar org={org} />
    </div>
  );
}
