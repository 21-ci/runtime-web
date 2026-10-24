import { Settings as SettingsTile } from "lucide-react";
import { IconTile } from "@/components/ui/icon-tile";
import { createFileRoute } from "@tanstack/react-router";

import { QuotaBar } from "@/components/features/org/quota-bar";
import { RotateDefaultKey } from "@/components/features/org/rotate-default-key";
import { useCan } from "@/hooks/authz";
import { useOrgs } from "@/hooks/orgs";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/$org/settings/general")({
  component: GeneralRoute,
});

// General shows the org's identity and its quota, and lets owners/admins rotate the default key.
// Renaming and deleting are not in v1 UI.
function GeneralRoute() {
  const { org } = Route.useParams();
  const orgs = useOrgs();
  const can = useCan(org);
  if (orgs.isPending) return <Skeleton className="h-40 w-full" />;
  const current = orgs.data?.find((o) => o.slug === org);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-[-0.01em]"><IconTile icon={SettingsTile} entity="settings" size="md" />Organization settings</h1>
      <dl className="grid max-w-md grid-cols-2 gap-2 text-sm">
        <dt className="text-muted">Name</dt>
        <dd>{current?.name ?? org}</dd>
        <dt className="text-muted">Slug</dt>
        <dd className="font-mono">{org}</dd>
      </dl>
      <QuotaBar org={org} />
      {can("defaultkey.rotate") === true ? <RotateDefaultKey org={org} /> : null}
    </div>
  );
}
