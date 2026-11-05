import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { AlertsPage } from "@/components/features/alerts/alerts-page";
import { ORG_KINDS, orgAlerts } from "@/components/features/alerts/use-alerts";
import { useOrgRole } from "@/components/features/members/hooks";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/$org/settings/alerts")({
  component: AlertsRoute,
});

function AlertsRoute() {
  const { t } = useTranslation("alerts");
  const { org } = Route.useParams();
  const { role, isPending } = useOrgRole(org);
  if (isPending) return <Skeleton className="h-64 w-full" />;
  if (role !== "owner" && role !== "admin") return <EmptyState title={t("adminsOnly")} description={t("adminsOnlyHint")} />;
  return <AlertsPage base={orgAlerts(org)} kinds={ORG_KINDS} allowApp />;
}
