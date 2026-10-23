import { createFileRoute } from "@tanstack/react-router";

import { CodePage } from "@/components/features/editor/code-page";

export const Route = createFileRoute("/$org/apps/$app/code")({
  component: CodeRoute,
});

function CodeRoute() {
  const { org, app } = Route.useParams();
  return <CodePage org={org} app={app} />;
}
