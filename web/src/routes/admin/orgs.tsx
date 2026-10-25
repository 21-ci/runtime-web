import { createFileRoute } from "@tanstack/react-router";

import { OrgsPage } from "@/components/features/admin/orgs-page";

export const Route = createFileRoute("/admin/orgs")({
  component: OrgsPage,
});
