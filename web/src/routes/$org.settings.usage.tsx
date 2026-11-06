import { createFileRoute } from "@tanstack/react-router";
import { Gauge } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PlanUsagePanel } from "@/components/features/org/plan-usage";
import { UsageTable } from "@/components/features/org/usage-table";
import { PageHeader } from "@/components/ui/page-header";
import { useOrgs } from "@/hooks/orgs";

export const Route = createFileRoute("/$org/settings/usage")({
  component: UsageRoute,
});

function UsageRoute() {
  const { t } = useTranslation("plans");
  const { org } = Route.useParams();
  const orgs = useOrgs();
  const role = orgs.data?.find((o) => o.slug === org)?.role;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader icon={Gauge} entity="settings" title={t("usage.title")} description={t("usage.description")} />
      <PlanUsagePanel org={org} />
      {orgs.isPending ? null : <UsageTable org={org} canSee={role === "owner" || role === "admin"} />}
    </div>
  );
}
