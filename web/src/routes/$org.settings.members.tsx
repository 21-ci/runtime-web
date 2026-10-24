import { Users as UsersTile } from "lucide-react";
import { IconTile } from "@/components/ui/icon-tile";
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
      <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-[-0.01em]"><IconTile icon={UsersTile} entity="members" size="md" />Members</h1>
      <MembersPage org={org} role={role} />
    </div>
  );
}
