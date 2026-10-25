import { KeyRound as KeyRoundTile } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { useOrgRole } from "@/components/features/members/hooks";
import { TokensPage } from "@/components/features/tokens/tokens-page";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/$org/settings/tokens")({
  component: TokensRoute,
});

function TokensRoute() {
  const { t } = useTranslation(["tokens"]);
  const { org } = Route.useParams();
  const { role, isPending } = useOrgRole(org);
  if (isPending) return <Skeleton className="h-64 w-full" />;
  if (!role) {
    return <EmptyState title={t("orgNotFound")} description={t("orgNotFoundHint")} />;
  }
  return (
    <div className="flex flex-col gap-6">
      <PageHeader icon={KeyRoundTile} entity="tokens" title={t("title")} />
      <TokensPage org={org} role={role} />
    </div>
  );
}
