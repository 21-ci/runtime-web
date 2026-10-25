import { createFileRoute } from "@tanstack/react-router";
import { Database } from "lucide-react";

import { KeyValueCard } from "@/components/features/admin/key-value-card";
import { useNodeCache } from "@/components/features/admin/use-admin";
import { PageHeader } from "@/components/ui/page-header";

export const Route = createFileRoute("/admin/cache")({
  component: AdminCachePage,
});

function AdminCachePage() {
  const cache = useNodeCache();
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader icon={Database} entity="admin" title="Cache" description="Read-only view of the node cache as the runtime reports it." />
      <KeyValueCard title="Node cache" query={cache} />
    </div>
  );
}
