import { createFileRoute } from "@tanstack/react-router";

import { UsersPage } from "@/components/features/admin/users-page";

export const Route = createFileRoute("/admin/users")({
  component: UsersPage,
});
