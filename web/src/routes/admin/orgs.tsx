import { createFileRoute } from "@tanstack/react-router";

import { AdminLayout } from "@/components/features/admin/admin-layout";
import { requireInstanceAdmin } from "@/components/features/admin/gate";
import { OrgsPage } from "@/components/features/admin/orgs-page";

export const Route = createFileRoute("/admin/orgs")({
  beforeLoad: ({ context }) => requireInstanceAdmin(context.queryClient),
  component: AdminOrgsRoute,
});

function AdminOrgsRoute() {
  return (
    <AdminLayout>
      <OrgsPage />
    </AdminLayout>
  );
}
