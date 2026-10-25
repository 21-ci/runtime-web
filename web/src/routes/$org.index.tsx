import { LayoutDashboard } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";

import { Dashboard } from "@/components/features/overview/dashboard";
import { QuotaBar } from "@/components/features/org/quota-bar";
import { UsageCard } from "@/components/features/org/usage-card";
import { PageHeader } from "@/components/ui/page-header";
import { useOrgs } from "@/hooks/orgs";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/$org/")({
  component: OrgOverview,
});

// OrgOverview is the org home: quick actions, projects, apps, activity and members, with quota
// and today's usage in a side rail.
function OrgOverview() {
  const { t } = useTranslation("overview");
  const { org } = Route.useParams();
  const orgs = useOrgs();
  const current = orgs.data?.find((o) => o.slug === org);
  const role = current?.role;
  const canSeeUsage = role === "owner" || role === "admin";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader icon={LayoutDashboard} entity="overview" title={t("title")} description={current ? t("workspace", { name: current.name }) : undefined} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Dashboard org={org} role={role} />
        <div className="flex flex-col gap-4">
          <QuotaBar org={org} />
          <UsageCard org={org} enabled={canSeeUsage} />
        </div>
      </div>
    </div>
  );
}
