import { createFileRoute, redirect } from "@tanstack/react-router";

import { requireInstanceAdmin } from "@/components/features/admin/gate";

// /admin has no page of its own: it sends instance admins to the user directory.
export const Route = createFileRoute("/admin/")({
  beforeLoad: async ({ context }) => {
    await requireInstanceAdmin(context.queryClient);
    throw redirect({ to: "/admin/users" });
  },
});
