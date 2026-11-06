import { createFileRoute, redirect } from "@tanstack/react-router";

// The Versions page became Deployments; old links keep working.
export const Route = createFileRoute("/$org/apps/$app/versions")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/$org/apps/$app/deployments", params, replace: true });
  },
});
