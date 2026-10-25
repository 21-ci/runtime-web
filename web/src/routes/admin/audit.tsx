import { createFileRoute } from "@tanstack/react-router";

import { AuditPage } from "@/components/features/admin/audit-page";

export const Route = createFileRoute("/admin/audit")({
  component: AuditPage,
});
