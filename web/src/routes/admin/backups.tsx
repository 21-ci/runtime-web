import { createFileRoute } from "@tanstack/react-router";

import { BackupsPage } from "@/components/features/admin/backups-page";

export const Route = createFileRoute("/admin/backups")({
  component: BackupsPage,
});
