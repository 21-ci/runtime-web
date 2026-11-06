import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { AuditPage } from "@/components/features/audit/audit-page";
import { parseAuditSearch } from "@/components/features/audit/audit-search";
import { useOrgRole } from "@/components/features/members/hooks";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/$org/settings/audit")({
  validateSearch: parseAuditSearch,
  component: AuditRoute,
});

// The audit log is for owners and admins; the server returns 403 to members.
function AuditRoute() {
  const { org } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { t } = useTranslation("audit");
  const { role, isPending } = useOrgRole(org);
  if (isPending) return <Skeleton className="h-64 w-full" />;
  if (role !== "owner" && role !== "admin") {
    return <EmptyState title={t("adminOnly.title")} description={t("adminOnly.description")} />;
  }
  return <AuditPage org={org} search={search} onSearchChange={(next) => void navigate({ search: next, replace: true })} />;
}
