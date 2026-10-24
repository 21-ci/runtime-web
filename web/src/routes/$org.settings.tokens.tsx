import { KeyRound as KeyRoundTile } from "lucide-react";
import { IconTile } from "@/components/ui/icon-tile";
import { createFileRoute } from "@tanstack/react-router";

import { useOrgRole } from "@/components/features/members/hooks";
import { TokensPage } from "@/components/features/tokens/tokens-page";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/$org/settings/tokens")({
  component: TokensRoute,
});

function TokensRoute() {
  const { org } = Route.useParams();
  const { role, isPending } = useOrgRole(org);
  if (isPending) return <Skeleton className="h-64 w-full" />;
  if (!role) {
    return <EmptyState title="Org not found" description="It may have been deleted or you lack access." />;
  }
  return (
    <div className="flex flex-col gap-6">
      <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-[-0.01em]"><IconTile icon={KeyRoundTile} entity="tokens" size="md" />Tokens</h1>
      <TokensPage org={org} role={role} />
    </div>
  );
}
