import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { useAppView } from "@/components/features/app-header/hooks";
import { EnvEditor } from "@/components/features/env/env-editor";
import { PreviewEnvCard } from "@/components/features/env/preview-env-card";
import { SecretsPanel } from "@/components/features/secrets/secrets-panel";
import { PageBody } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Lock } from "lucide-react";
import { useCan } from "@/hooks/authz";

export const Route = createFileRoute("/$org/apps/$app/env")({
  component: EnvRoute,
});

// Environment: the plain variables, the write-only secrets and what preview apps receive, each with its own save.
function EnvRoute() {
  const { org, app } = Route.useParams();
  const view = useAppView(org, app);
  const can = useCan(org, view.data?.project);
  const { t } = useTranslation("env");
  return (
    <PageBody className="gap-6">
      <PageHeader icon={Lock} entity="env" title={t("page.title")} description={t("page.description")} />
      <EnvEditor org={org} app={app} canWrite={can("app.env.write") === true} />
      <SecretsPanel org={org} app={app} canWrite={can("app.secrets.write") === true} />
      <PreviewEnvCard org={org} app={app} canWrite={can("app.env.write") === true} />
    </PageBody>
  );
}
