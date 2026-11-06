import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { AuditPage } from "@/components/features/admin/audit-page";
import { parseAuditSearch } from "@/components/features/audit/audit-search";

export const Route = createFileRoute("/admin/audit")({
  validateSearch: parseAuditSearch,
  component: AdminAuditRoute,
});

function AdminAuditRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return <AuditPage search={search} onSearchChange={(next) => void navigate({ search: next, replace: true })} />;
}
