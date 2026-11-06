import { useTranslation } from "react-i18next";

import { QueryError } from "@/components/features/empty/query-error";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { ExportMenu } from "@/components/ui/export-menu";
import { SectionCard } from "@/components/ui/section-card";
import { useUsage, type Usage } from "@/hooks/orgs";
import { formatBytes, formatCount, formatDuration } from "@/lib/format";

// UsageTable shows today's usage per app, as the runtime counts it: a UTC day. It asks for nothing unless the caller
// says the viewer may read usage. Storage stays out: the runtime's counter is 0 whatever the disk holds.
export function UsageTable({ org, canSee }: { org: string; canSee: boolean }) {
  const { t } = useTranslation("org");
  const day = new Date().toISOString().slice(0, 10);
  const usage = useUsage(org, canSee, day);
  const rows = usage.data ?? [];
  const columns: DataColumn<Usage>[] = [
    { key: "app", header: t("usageCard.app"), primary: true, sortValue: (r) => r.app ?? "", cell: (r) => r.app ?? <span className="text-muted">{t("usageCard.deletedApp")}</span> },
    { key: "invocations", header: t("usageCard.invocations"), align: "right", sortValue: (r) => r.invocations, cell: (r) => formatCount(r.invocations) },
    { key: "cpu", header: t("usageCard.cpu"), align: "right", sortValue: (r) => r.cpu_ms, cell: (r) => formatDuration(r.cpu_ms) },
    { key: "egress", header: t("usageCard.egress"), align: "right", sortValue: (r) => r.egress_bytes, cell: (r) => formatBytes(r.egress_bytes) },
  ];
  const enc = encodeURIComponent;
  return (
    <SectionCard
      title={t("usageCard.title")}
      description={t("usageCard.description")}
      actions={canSee ? <ExportMenu formats={["csv"]} href={(f) => `/api/orgs/${enc(org)}/usage?format=${f}&from=${day}&to=${day}`} disabled={rows.length === 0} /> : null}
    >
      {!canSee ? (
        <EmptyState variant="permission" title={t("usageCard.adminsOnly")} />
      ) : usage.isError ? (
        <QueryError error={usage.error} onRetry={() => void usage.refetch()} notFoundTitle={t("usageCard.title")} />
      ) : (
        <DataTable
          label={t("usageCard.title")}
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.day}/${r.app ?? "deleted"}`}
          loading={usage.isPending}
          empty={<EmptyState variant="no-range" title={t("usageCard.empty")} />}
        />
      )}
    </SectionCard>
  );
}
