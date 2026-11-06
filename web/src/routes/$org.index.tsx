import { LayoutDashboard } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { Dashboard } from "@/components/features/overview/dashboard";
import { PageHeader } from "@/components/ui/page-header";
import { useOrgs } from "@/hooks/orgs";

export const Route = createFileRoute("/$org/")({
  component: OrgOverview,
});

function OrgOverview() {
  const { t } = useTranslation("overview");
  const { org } = Route.useParams();
  const orgs = useOrgs();
  const current = orgs.data?.find((o) => o.slug === org);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader icon={LayoutDashboard} entity="overview" title={t("title")} description={current ? t("workspace", { name: current.name }) : undefined} />
      <Dashboard org={org} role={current?.role} />
    </div>
  );
}
