import { useState, type FormEvent } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";

import { AuthForm, FormField } from "@/components/auth/auth-form";
import { QueryError } from "@/components/features/empty/query-error";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";

// Shape from docs/api-web.md §1.6 and §7 (AuditEntry). Pages are cursor based.
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
    <section aria-labelledby="audit-heading" className="flex flex-col gap-4">
      <header>
        <h2 id="audit-heading" className="text-sm font-semibold">
          Audit log
        </h2>
        <p className="text-sm text-muted">Who changed what in this org, newest first.</p>
      </header>

      <AuthForm errors={{}} onSubmit={onSubmit}>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Actor user ID" name="actor" defaultValue={filters.actor} autoComplete="off" spellCheck={false} />
          <FormField label="Action" name="action" defaultValue={filters.action} placeholder="app.create" autoComplete="off" spellCheck={false} />
        </div>
        <div>
          <Button type="submit" variant="secondary">
            Apply filters
          </Button>
        </div>
      </AuthForm>

      {audit.isError ? (
        <QueryError error={audit.error} onRetry={() => void audit.refetch()} notFoundTitle="Org not found" />
      ) : audit.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : entries.length === 0 ? (
        <EmptyState entity="audit" icon={ScrollText} title="No matching entries" description="Try different filters." />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{new Date(e.at).toLocaleString()}</TableCell>
                  <TableCell>
                    {e.actor.name ?? e.actor.email ?? e.actor.user_id ?? "Unknown"}
                    {e.actor.user_id ? <span className="block text-xs text-muted">{e.actor.user_id}</span> : null}
                  </TableCell>
                  <TableCell className="font-mono">{e.action}</TableCell>
                  <TableCell>{e.target}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {audit.hasNextPage ? (
            <div>
              <Button variant="secondary" onClick={() => void audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>
                Load more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
