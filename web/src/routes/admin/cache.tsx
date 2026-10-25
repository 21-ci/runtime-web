import { createFileRoute } from "@tanstack/react-router";
import { Database } from "lucide-react";
import { useTranslation } from "react-i18next";

import { KeyValueCard } from "@/components/features/admin/key-value-card";
import { useNodeCache } from "@/components/features/admin/use-admin";
import { PageHeader } from "@/components/ui/page-header";

export const Route = createFileRoute("/admin/cache")({
  component: AdminCachePage,
});

function AdminCachePage() {
  const { t } = useTranslation("admin");
  const cache = useNodeCache();
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader icon={Database} entity="admin" title={t("cache.title")} description={t("cache.description")} />
      <KeyValueCard title={t("cache.cardTitle")} query={cache} />
    </div>
  );
}
