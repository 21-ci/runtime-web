import { createFileRoute } from "@tanstack/react-router";

import { AdminLayout } from "@/components/features/admin/admin-layout";
import { requireInstanceAdmin } from "@/components/features/admin/gate";
import { UsersPage } from "@/components/features/admin/users-page";

export const Route = createFileRoute("/admin/users")({
  beforeLoad: ({ context }) => requireInstanceAdmin(context.queryClient),
  component: AdminUsersRoute,
});

function AdminUsersRoute() {
  return (
    <AdminLayout>
      <UsersPage />
    </AdminLayout>
  );
}
