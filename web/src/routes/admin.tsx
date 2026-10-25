import { createFileRoute, Outlet } from "@tanstack/react-router";

import { AdminLayout } from "@/components/features/admin/admin-layout";
import { requireInstanceAdmin } from "@/components/features/admin/gate";

// Every instance-admin page renders inside the console shell. The gate runs once here for all of
// /admin/*; the API still authorizes every admin call on its own.
export const Route = createFileRoute("/admin")({
  beforeLoad: ({ context }) => requireInstanceAdmin(context.queryClient),
  component: AdminRoute,
});

function AdminRoute() {
  return (
    <AdminLayout>
      <Outlet />
    </AdminLayout>
  );
}
