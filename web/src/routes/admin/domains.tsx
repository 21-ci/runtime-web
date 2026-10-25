import { Globe } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { QueryError } from "@/components/features/empty/query-error";
import { useAdminDomains, type DomainRow } from "@/components/features/admin/use-admin";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate } from "@/lib/format";

export const Route = createFileRoute("/admin/domains")({
  component: AdminDomainsPage,
});

const STATUS_VARIANT: Record<DomainRow["status"], "success" | "danger" | "info"> = {
  active: "success",
  pending: "info",
  failed: "danger",
};

const CERT_VARIANT: Record<DomainRow["cert_status"], "success" | "danger" | "info" | "outline"> = {
  issued: "success",
  pending: "info",
  error: "danger",
  none: "outline",
};

const STATUS_KEY = {
  active: "domains.status.active",
  pending: "domains.status.pending",
  failed: "domains.status.failed",
} as const satisfies Record<DomainRow["status"], string>;

const CERT_KEY = {
  issued: "domains.cert.issued",
  pending: "domains.cert.pending",
  error: "domains.cert.error",
  none: "domains.cert.none",
} as const satisfies Record<DomainRow["cert_status"], string>;

// AdminDomainsPage lists custom domains across every org, so an instance admin can see certificate
// trouble without opening each org.
function AdminDomainsPage() {
  const { t } = useTranslation(["admin", "common"]);
  const domains = useAdminDomains();

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader icon={Globe} entity="admin" title={t("domains.title")} description={t("domains.description")} />
      {domains.isError ? (
        <QueryError error={domains.error} onRetry={() => void domains.refetch()} notFoundTitle={t("notAvailable")} />
      ) : domains.isPending ? (
        <div aria-busy="true">
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (domains.data ?? []).length === 0 ? (
        <EmptyState entity="domains" icon={Globe} title={t("domains.emptyTitle")} description={t("domains.emptyDescription")} />
      ) : (
          <Table>
            <caption className="sr-only">{t("domains.caption")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("domains.columns.host")}</TableHead>
                <TableHead scope="col">{t("domains.columns.organization")}</TableHead>
                <TableHead scope="col">{t("domains.columns.app")}</TableHead>
                <TableHead scope="col">{t("domains.columns.status")}</TableHead>
                <TableHead scope="col">{t("domains.columns.certificate")}</TableHead>
                <TableHead scope="col">{t("domains.columns.certExpires")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(domains.data ?? []).map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="max-w-64 break-all font-mono">{d.host}</TableCell>
                  <TableCell>
                    <span>{d.org.name}</span>
                  </TableCell>
                  <TableCell>{d.app}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[d.status]}>{t(STATUS_KEY[d.status])}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={CERT_VARIANT[d.cert_status]}>{t(CERT_KEY[d.cert_status])}</Badge>
                    {d.cert_error ? <p className="mt-1 max-w-64 break-words text-xs text-danger">{d.cert_error}</p> : null}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {d.cert_not_after ? formatDate(d.cert_not_after) : "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
      )}
    </div>
  );
}
