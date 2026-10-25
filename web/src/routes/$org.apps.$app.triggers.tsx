import { createFileRoute } from "@tanstack/react-router";

import { PageBody } from "@/components/layout/app-shell";

import { TriggersPage } from "@/components/features/triggers/triggers-page";

export const Route = createFileRoute("/$org/apps/$app/triggers")({
  component: TriggersRoute,
});

function TriggersRoute() {
  const { org, app } = Route.useParams();
  return (
    <PageBody>
      <TriggersPage org={org} app={app} />
    </PageBody>
  );
}
