import { createFileRoute } from "@tanstack/react-router";

import { CodePage } from "@/components/features/editor/code-page";

// Not nested under the app header route: the code page needs the full width.
export const Route = createFileRoute("/$org/apps/$app_/code")({
  component: CodeRoute,
});

function CodeRoute() {
  const { org, app } = Route.useParams();
  return <CodePage org={org} app={app} />;
}
