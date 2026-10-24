import { createFileRoute } from "@tanstack/react-router";

import { useAppView } from "@/components/features/app-header/hooks";
import { EnvEditor } from "@/components/features/env/env-editor";
import { SecretsPanel } from "@/components/features/secrets/secrets-panel";
import { PageBody } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Lock } from "lucide-react";
import { useCan } from "@/hooks/authz";

export const Route = createFileRoute("/$org/apps/$app/env")({
  component: EnvRoute,
});

// Env & Secrets: the plain variables table and the write-only secrets, each with its own save.
function EnvRoute() {
  const { org, app } = Route.useParams();
  const view = useAppView(org, app);
  const can = useCan(org, view.data?.project);
  return (
    <PageBody className="gap-6">
      <PageHeader icon={Lock} entity="env" title="Env & Secrets" description="Configuration and credentials the app reads at run time." />
      <EnvEditor org={org} app={app} canWrite={can("app.env.write") === true} />
      <SecretsPanel org={org} app={app} canWrite={can("app.secrets.write") === true} />
    </PageBody>
  );
}
