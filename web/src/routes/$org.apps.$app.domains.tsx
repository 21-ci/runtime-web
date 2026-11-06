import { createFileRoute, redirect } from "@tanstack/react-router";

// Domains moved into Settings. Old links and bookmarks still land there.
export const Route = createFileRoute("/$org/apps/$app/domains")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/$org/apps/$app/settings", params, search: { section: "integrations" }, replace: true });
  },
});
