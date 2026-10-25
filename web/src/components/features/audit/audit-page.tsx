import { useState, type FormEvent } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AuthForm, FormField } from "@/components/auth/auth-form";
import { QueryError } from "@/components/features/empty/query-error";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

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

type Filters = { actor: string; action: string };

// AuditPage lists this org's audit entries. Filters are applied on the server.
export function AuditPage({ org }: { org: string }) {
  const { t } = useTranslation(["audit", "common"]);
  const [filters, setFilters] = useState<Filters>({ actor: "", action: "" });
  const audit = useInfiniteQuery({
    queryKey: ["audit", org, filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: "50" });
      if (filters.actor) q.set("actor", filters.actor);
      if (filters.action) q.set("action", filters.action);
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
    setFilters({
      actor: String(data.get("actor") ?? "").trim(),
      action: String(data.get("action") ?? "").trim(),
    });
  }

  const entries = audit.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section aria-labelledby="audit-heading" className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-card">
      <header>
        <h2 id="audit-heading" className="text-[15px] font-semibold">
          {t("title")}
        </h2>
        <p className="text-sm text-muted">{t("description")}</p>
      </header>

      <AuthForm errors={{}} onSubmit={onSubmit}>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label={t("filters.actor")} name="actor" defaultValue={filters.actor} autoComplete="off" spellCheck={false} />
          <FormField label={t("filters.action")} name="action" defaultValue={filters.action} placeholder="app.create" autoComplete="off" spellCheck={false} />
        </div>
        <div>
          <Button type="submit" variant="secondary">
            {t("filters.apply")}
          </Button>
        </div>
      </AuthForm>

      {audit.isError ? (
        <QueryError error={audit.error} onRetry={() => void audit.refetch()} notFoundTitle={t("orgNotFound")} />
      ) : audit.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : entries.length === 0 ? (
        <EmptyState entity="audit" icon={ScrollText} title={t("empty.title")} description={t("empty.description")} />
      ) : (
        <>
          <Table>
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
                    <span className="block break-words">{e.actor.name ?? e.actor.email ?? e.actor.user_id ?? t("unknownActor")}</span>
                    {e.actor.user_id ? <span className="block break-all text-xs text-muted">{e.actor.user_id}</span> : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono">{e.action}</TableCell>
                  <TableCell className="min-w-40 max-w-72 break-all">{e.target}</TableCell>
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
  );
}
