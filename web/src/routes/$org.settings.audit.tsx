import { ScrollText as ScrollTextTile } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
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
      <PageHeader icon={ScrollTextTile} entity="audit" title="Audit log" />
      <AuditPage org={org} />
    </div>
  );
}
