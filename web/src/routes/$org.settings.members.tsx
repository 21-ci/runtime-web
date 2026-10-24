import { Users as UsersTile } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { createFileRoute } from "@tanstack/react-router";

import { MembersPage } from "@/components/features/members/members-page";
import { useOrgRole } from "@/components/features/members/hooks";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/$org/settings/members")({
  component: MembersRoute,
});

function MembersRoute() {
  const { org } = Route.useParams();
  const { role, isPending } = useOrgRole(org);
  if (isPending) return <Skeleton className="h-64 w-full" />;
  if (!role) {
    return <EmptyState title="Org not found" description="It may have been deleted or you lack access." />;
  }
  return (
    <div className="flex flex-col gap-6">
      <PageHeader icon={UsersTile} entity="members" title="Members" />
      <MembersPage org={org} role={role} />
    </div>
  );
}
