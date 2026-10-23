import { createFileRoute } from "@tanstack/react-router";

import { KeyValueCard } from "@/components/features/admin/key-value-card";
import { useNodeCache } from "@/components/features/admin/use-admin";

export const Route = createFileRoute("/admin/cache")({
  component: AdminCachePage,
});

function AdminCachePage() {
  const cache = useNodeCache();
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <h1 className="text-xl font-semibold">Cache</h1>
      <p className="text-sm text-muted">Read-only view of the node cache as the runtime reports it.</p>
      <KeyValueCard title="Node cache" query={cache} />
    </div>
  );
}
