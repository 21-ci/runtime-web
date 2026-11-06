import { useMemo, type FormEvent } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AuthForm, FormField } from "@/components/auth/auth-form";
import { QueryError } from "@/components/features/empty/query-error";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ExportMenu } from "@/components/ui/export-menu";
import { PageHeader } from "@/components/ui/page-header";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useMembers } from "@/components/features/members/hooks";
import { useOrgs } from "@/hooks/orgs";

import { AUDIT_PERIODS, patchAuditSearch, sinceFor, type AuditPeriod, type AuditSearch } from "./audit-search";
import { AuditTarget } from "./audit-target";

// Shape from docs/reference/api.md §1.6 and §7 (AuditEntry). Pages are cursor based.
export type AuditEntry = {
  id: string;
  at: number;
  actor: { user_id: string | null; name: string | null; email: string | null };
  as_instance_admin: boolean;
  org: { id: string; slug: string } | null;
  action: string;
  target: string;
  detail: unknown;
};

type Filters = { actor: string; action: string; since: string };

// The page size of an audit list (guidelines rule 5). The API pages by cursor and has no total.
const PAGE_SIZE = 20;
const ALL_ACTORS = "all";
const EXPORT_FORMATS = ["csv", "ndjson"] as const;

// AuditPage lists this org's audit entries. Filters live in the URL and are applied on the server.
export function AuditPage({ org, search, onSearchChange }: { org: string; search: AuditSearch; onSearchChange: (next: AuditSearch) => void }) {
  const { t } = useTranslation(["audit", "common"]);
  const period: AuditPeriod = search.period ?? "all";
  const since = useMemo(() => sinceFor(period), [period]);
  const filters: Filters = { actor: search.actor ?? "", action: search.action ?? "", since };
  const members = useMembers(org);
  const orgs = useOrgs();
  const audit = useInfiniteQuery({
    queryKey: ["audit", org, filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const q = auditQuery(filters);
      q.set("limit", String(PAGE_SIZE));
      if (pageParam) q.set("cursor", pageParam);
      return api.get<{ items: AuditEntry[]; next_cursor: string | null }>(
        `/orgs/${encodeURIComponent(org)}/audit?${q.toString()}`,
      );
    },
    getNextPageParam: (last) => last.next_cursor,
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    onSearchChange(patchAuditSearch(search, { action: String(data.get("action") ?? "").trim() }));
  }

  const entries = audit.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        icon={ScrollText}
        entity="audit"
        title={t("title")}
        description={t("description")}
        actions={
          <ExportMenu
            formats={EXPORT_FORMATS}
            href={(format) => `/api/orgs/${encodeURIComponent(org)}/audit?${auditQuery(filters, format).toString()}`}
          />
        }
      />
      <section aria-label={t("title")} className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-card">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-48 flex-col gap-1.5">
          <span className="text-[13px] font-medium text-muted" id="audit-actor-label">
            {t("filters.actorLabel")}
          </span>
          <Select
            value={filters.actor || ALL_ACTORS}
            onValueChange={(v) => onSearchChange(patchAuditSearch(search, { actor: v === ALL_ACTORS ? "" : v }))}
          >
            <SelectTrigger aria-label={t("filters.actorLabel")} aria-labelledby="audit-actor-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_ACTORS}>{t("filters.allActors")}</SelectItem>
              {(members.data ?? []).map((m) => (
                <SelectItem key={m.user.id} value={m.user.id}>
                  {m.user.name || m.user.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-muted">{t("filters.period")}</span>
          <Segmented
            label={t("filters.period")}
            value={period}
            onChange={(next: AuditPeriod) => onSearchChange(patchAuditSearch(search, { period: next }))}
            options={AUDIT_PERIODS.map((p) => ({ value: p, label: t(`filters.periods.${p}`) }))}
          />
        </div>
        <AuthForm errors={{}} onSubmit={onSubmit}>
          <div className="flex flex-wrap items-end gap-3">
            <FormField key={filters.action} label={t("filters.action")} name="action" defaultValue={filters.action} placeholder="app.create" autoComplete="off" spellCheck={false} />
            <Button type="submit" variant="secondary">
              {t("filters.apply")}
            </Button>
          </div>
        </AuthForm>
      </div>

      {audit.isError ? (
        <QueryError error={audit.error} onRetry={() => void audit.refetch()} notFoundTitle={t("orgNotFound")} />
      ) : audit.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : entries.length === 0 ? (
        <EmptyState entity="audit" icon={ScrollText} title={t("empty.title")} description={t("empty.description")} />
      ) : (
        <>
          <Table stack>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.when")}</TableHead>
                <TableHead>{t("columns.actor")}</TableHead>
                <TableHead>{t("columns.action")}</TableHead>
                <TableHead>{t("columns.target")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap">{formatDateTime(e.at)}</TableCell>
                  <TableCell className="min-w-40 max-w-64">
                    <span className="block break-words" title={e.actor.user_id ?? undefined}>
                      {e.actor.name ?? e.actor.email ?? t("unknownActor")}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono">{e.action}</TableCell>
                  <TableCell className="min-w-40 max-w-72 break-all"><AuditTarget target={e.target} orgs={orgs.data} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {audit.hasNextPage ? (
            <div>
              <Button variant="secondary" onClick={() => void audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>
                {t("loadMore")}
              </Button>
            </div>
          ) : null}
        </>
      )}
      </section>
    </div>
  );
}

// auditQuery is the filter set as search params, shared by the list and the export so both show the same rows.
function auditQuery(filters: Filters, format?: string): URLSearchParams {
  const q = new URLSearchParams();
  if (format) q.set("format", format);
  if (filters.actor) q.set("actor", filters.actor);
  if (filters.action) q.set("action", filters.action);
  if (filters.since) q.set("since", filters.since);
  return q;
}
