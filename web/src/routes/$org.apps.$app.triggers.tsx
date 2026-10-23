import { createFileRoute } from "@tanstack/react-router";

import { TriggersPage } from "@/components/features/triggers/triggers-page";

export const Route = createFileRoute("/$org/apps/$app/triggers")({
  component: TriggersRoute,
});

function TriggersRoute() {
  const { org, app } = Route.useParams();
  return <TriggersPage org={org} app={app} />;
}
