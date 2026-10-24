import { createFileRoute } from "@tanstack/react-router";

import { AdminLayout } from "@/components/features/admin/admin-layout";
import { AuditPage } from "@/components/features/admin/audit-page";
import { requireInstanceAdmin } from "@/components/features/admin/gate";

export const Route = createFileRoute("/admin/audit")({
  beforeLoad: ({ context }) => requireInstanceAdmin(context.queryClient),
  component: AdminAuditRoute,
});

function AdminAuditRoute() {
  return (
    <AdminLayout>
      <AuditPage />
    </AdminLayout>
  );
}
