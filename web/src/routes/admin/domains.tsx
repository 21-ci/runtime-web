import { createFileRoute } from "@tanstack/react-router";

import { AdminLayout } from "@/components/features/admin/admin-layout";
import { requireInstanceAdmin } from "@/components/features/admin/gate";
import { QueryError } from "@/components/features/empty/query-error";
import { useAdminDomains, type DomainRow } from "@/components/features/admin/use-admin";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/admin/domains")({
  beforeLoad: ({ context }) => requireInstanceAdmin(context.queryClient),
  component: AdminDomainsPageRoute,
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

// AdminDomainsPage lists custom domains across every org, so an instance admin can see certificate
// trouble without opening each org.
function AdminDomainsPageRoute() {
  return (
    <AdminLayout>
      <AdminDomainsPage />
    </AdminLayout>
  );
}

function AdminDomainsPage() {
  const domains = useAdminDomains();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <h1 className="text-xl font-semibold">Domains</h1>
      {domains.isError ? (
        <QueryError error={domains.error} onRetry={() => void domains.refetch()} notFoundTitle="Not available" />
      ) : domains.isPending ? (
        <div aria-busy="true">
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (domains.data ?? []).length === 0 ? (
        <p className="text-sm text-muted">No custom domains yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-[10px] border border-line bg-surface">
          <Table>
            <caption className="sr-only">Custom domains across all orgs</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Host</TableHead>
                <TableHead scope="col">Org</TableHead>
                <TableHead scope="col">App</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Certificate</TableHead>
                <TableHead scope="col">Cert expires</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(domains.data ?? []).map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-mono">{d.host}</TableCell>
                  <TableCell>
                    <span>{d.org.name}</span>
                  </TableCell>
                  <TableCell>{d.app}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[d.status]}>{d.status}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={CERT_VARIANT[d.cert_status]}>{d.cert_status}</Badge>
                    {d.cert_error ? <p className="mt-1 text-xs text-danger">{d.cert_error}</p> : null}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {d.cert_not_after ? new Date(d.cert_not_after).toLocaleDateString() : "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
