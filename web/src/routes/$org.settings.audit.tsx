import { ScrollText as ScrollTextTile } from "lucide-react";
import { IconTile } from "@/components/ui/icon-tile";
import { createFileRoute } from "@tanstack/react-router";

import { AuditPage } from "@/components/features/audit/audit-page";
import { useOrgRole } from "@/components/features/members/hooks";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/$org/settings/audit")({
  component: AuditRoute,
});

// The audit log is for owners and admins; the server returns 403 to members.
function AuditRoute() {
  const { org } = Route.useParams();
  const { role, isPending } = useOrgRole(org);
  if (isPending) return <Skeleton className="h-64 w-full" />;
  if (role !== "owner" && role !== "admin") {
    return <EmptyState title="Audit log is for admins" description="Ask an owner or admin for the log." />;
  }
  return (
    <div className="flex flex-col gap-6">
      <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-[-0.01em]"><IconTile icon={ScrollTextTile} entity="audit" size="md" />Audit log</h1>
      <AuditPage org={org} />
    </div>
  );
}
