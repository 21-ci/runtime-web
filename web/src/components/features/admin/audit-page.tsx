import { ScrollText } from "lucide-react";
import { useId, useState } from "react";

import { QueryError } from "@/components/features/empty/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useAdminAudit, useAdminOrgs, useUserOptions, type AuditFilters } from "./admin-api";

// Radix Select items cannot have an empty value, so the "any" choices use sentinels.
const ALL_ORGS = "__all__";
const ANY_ACTOR = "__any__";

// AuditPage is the instance-wide audit log. Filters go to the API (org slug, actor user id, action),
// so each change reloads from the first page.
export function AuditPage() {
  const [filters, setFilters] = useState<AuditFilters>({ org: "", actor: "", action: "" });
  const orgs = useAdminOrgs();
  const users = useUserOptions();
  const audit = useAdminAudit({ ...filters, action: filters.action.trim() });
  const orgId = useId();
  const actorId = useId();
  const actionId = useId();
  const items = audit.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader icon={ScrollText} entity="admin" title="Audit log" description="Every instance-wide change, newest first." />

      <form className="grid gap-3 sm:grid-cols-3" role="search" aria-label="Filter audit log" onSubmit={(e) => e.preventDefault()}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={orgId}>Organization</Label>
          <Select
            value={filters.org || ALL_ORGS}
            onValueChange={(v) => setFilters((f) => ({ ...f, org: v === ALL_ORGS ? "" : v }))}
          >
            <SelectTrigger id={orgId} className="h-8 min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_ORGS}>All organizations</SelectItem>
              {(orgs.data ?? []).map((o) => (
                <SelectItem key={o.slug} value={o.slug}>
                  {o.name} ({o.slug})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={actorId}>Actor</Label>
          <Select
            value={filters.actor || ANY_ACTOR}
            onValueChange={(v) => setFilters((f) => ({ ...f, actor: v === ANY_ACTOR ? "" : v }))}
          >
            <SelectTrigger id={actorId} className="h-8 min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_ACTOR}>Any actor</SelectItem>
              {(users.data ?? []).map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={actionId}>Action</Label>
          <Input
            id={actionId}
            placeholder="for example app.create"
            value={filters.action}
            onChange={(e) => setFilters((f) => ({ ...f, action: e.target.value }))}
          />
        </div>
      </form>

      {audit.isError ? (
        <QueryError error={audit.error} onRetry={() => void audit.refetch()} notFoundTitle="Audit log not found" />
      ) : audit.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState entity="audit"
          icon={ScrollText}
          title="No entries match"
          description="Clear a filter to see more of the log."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Organization</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Detail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="whitespace-nowrap text-sm">{new Date(entry.at).toLocaleString()}</TableCell>
                <TableCell className="text-sm">
                  <span className="flex flex-wrap items-center gap-1">
                    {entry.actor.name ?? entry.actor.email ?? entry.actor.user_id ?? "Unknown"}
                    {entry.as_instance_admin ? <Badge variant="info">As instance admin</Badge> : null}
                  </span>
                </TableCell>
                <TableCell className="max-w-40 break-all text-sm">{entry.org?.slug ?? "Instance"}</TableCell>
                <TableCell className="whitespace-nowrap font-mono text-sm">{entry.action}</TableCell>
                <TableCell className="min-w-40 max-w-72 break-all text-sm">{entry.target}</TableCell>
                <TableCell>
                  <pre className="min-w-48 max-w-xs whitespace-pre-wrap break-all font-mono text-xs text-muted">
                    {entry.detail === null || entry.detail === undefined ? "" : JSON.stringify(entry.detail)}
                  </pre>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {audit.hasNextPage ? (
        <div>
          <Button variant="secondary" onClick={() => void audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>
            Load more entries
          </Button>
        </div>
      ) : null}
    </div>
  );
}
