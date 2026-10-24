import { createFileRoute } from "@tanstack/react-router";
import { Globe } from "lucide-react";

import { useAppView } from "@/components/features/app-header/hooks";
import { DomainsPanel } from "@/components/features/domains/domains-panel";
import { PageBody } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { useCan } from "@/hooks/authz";

export const Route = createFileRoute("/$org/apps/$app/domains")({
  component: DomainsRoute,
});

function DomainsRoute() {
  const { org, app } = Route.useParams();
  const view = useAppView(org, app);
  const can = useCan(org, view.data?.project);
  return (
    <PageBody className="gap-6">
      <PageHeader icon={Globe} entity="domains" title="Domains" description="Serve this app on your own hostnames." />
      <DomainsPanel org={org} app={app} canWrite={can("domains.manage") === true} />
    </PageBody>
  );
}
