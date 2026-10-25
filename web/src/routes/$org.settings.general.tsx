import { Settings as SettingsTile } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { ROLE_KEY } from "@/components/features/members/roles";
import { QuotaBar } from "@/components/features/org/quota-bar";
import { RotateDefaultKey } from "@/components/features/org/rotate-default-key";
import { useCan } from "@/hooks/authz";
import { useOrgs } from "@/hooks/orgs";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/$org/settings/general")({
  component: GeneralRoute,
});

// General shows the org's identity and its quota, and lets owners/admins rotate the default key.
// Renaming and deleting are not in v1 UI.
function GeneralRoute() {
  const { t } = useTranslation(["org", "common", "members"]);
  const { org } = Route.useParams();
  const orgs = useOrgs();
  const can = useCan(org);
  if (orgs.isPending) return <Skeleton className="h-40 w-full" />;
  const current = orgs.data?.find((o) => o.slug === org);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader icon={SettingsTile} entity="settings" title={t("general.title")} />
      <SectionCard title={t("identity.title")} description={t("identity.description")}>
        <dl className="grid max-w-md grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted">{t("common:name")}</dt>
          <dd className="min-w-0 break-words font-medium">{current?.name ?? org}</dd>
          <dt className="text-muted">{t("identity.slug")}</dt>
          <dd className="min-w-0 break-all font-mono text-[13px]">{org}</dd>
          <dt className="text-muted">{t("identity.role")}</dt>
          <dd className="capitalize">{current?.role ? t(ROLE_KEY[current.role]) : "-"}</dd>
        </dl>
      </SectionCard>
      <div className="grid gap-6 lg:grid-cols-2">
        <QuotaBar org={org} />
        {can("defaultkey.rotate") === true ? <RotateDefaultKey org={org} /> : null}
      </div>
    </div>
  );
}
