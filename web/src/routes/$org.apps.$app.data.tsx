import { createFileRoute } from "@tanstack/react-router";

import { useAppDetail } from "@/components/features/app-settings/api";
import { DataBrowser } from "@/components/features/data/data-browser";
import { PageBody } from "@/components/layout/app-shell";

export const Route = createFileRoute("/$org/apps/$app/data")({
  component: AppDataPage,
});

function AppDataPage() {
  const { org, app } = Route.useParams();
  const detail = useAppDetail(org, app);
  return (
    <PageBody>
      <DataBrowser org={org} app={app} project={detail.data?.project} />
    </PageBody>
  );
}
