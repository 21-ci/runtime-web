import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { Building2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrgs } from "@/hooks/orgs";

// HomePage sends a signed-in user to their first organization. With none, it says so and points
// instance admins at the admin area, where organizations are created.
function HomePage() {
  const orgs = useOrgs();

  if (orgs.isPending) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 p-6" aria-busy="true">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-24 w-full" />
      </main>
    );
  }

  const first = orgs.data?.[0];
  if (first) return <Navigate to="/$org" params={{ org: first.slug }} replace />;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center p-6">
      <h1 className="mb-4 text-lg font-semibold">Runtime Console</h1>
      {orgs.isError ? (
        <EmptyState
          title="Could not load organizations"
          description="Check the connection and try again."
          action={<Button onClick={() => void orgs.refetch()}>Retry</Button>}
        />
      ) : (
        <EmptyState
          icon={Building2}
          title="No organizations yet"
          description="Ask an owner for an invite. Instance admins can create one in Admin."
          action={
            <Button asChild variant="default">
              <Link to="/admin">Open Admin</Link>
            </Button>
          }
        />
      )}
    </main>
  );
}

export const Route = createFileRoute("/")({
  component: HomePage,
});
