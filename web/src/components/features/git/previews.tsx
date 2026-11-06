import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { QueryError } from "@/components/features/empty/query-error";
import { Badge } from "@/components/ui/badge";
import { BoundedItems } from "@/components/ui/bounded";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCan } from "@/hooks/authz";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

// Shape from docs/reference/api.md §8.2.3.
export type Preview = {
  pr: number;
  sha: string;
  slug: string | null;
  url: string | null;
  fork: boolean;
  held: boolean;
  approved_sha: string | null;
  approved_with_env: boolean;
  created_at: number;
  last_deploy_at: number | null;
  expires_at: number;
};

const base = (org: string, app: string) => `/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}`;

export function PreviewsCard({ org, app, project }: { org: string; app: string; project: string | undefined }) {
  const { t } = useTranslation("platform");
  const can = useCan(org, project);
  const qc = useQueryClient();
  const key = ["previews", org, app];
  const list = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ items: Preview[] }>(`${base(org, app)}/previews`),
    refetchInterval: 15_000,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const remove = useMutation({ mutationFn: (pr: number) => api.del<null>(`${base(org, app)}/previews/${pr}`), onSuccess: refresh });
  const approve = useMutation({
    mutationFn: (v: { pr: number; sha: string; with_env: boolean }) => api.post(`${base(org, app)}/previews/${v.pr}/approve`, { sha: v.sha, with_env: v.with_env }),
    onSuccess: refresh,
  });
  const [approving, setApproving] = useState<Preview | null>(null);
  const [withEnv, setWithEnv] = useState(false);
  const [deleting, setDeleting] = useState<Preview | null>(null);
  const items = list.data?.items;
  return (
    <SectionCard title={t("previews.title")}>
      <p className="mb-3 text-sm text-muted">{t("previews.description")}</p>
      {list.isError ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} notFoundTitle={t("previews.title")} />
      ) : !items ? (
        <Skeleton className="h-16 w-full" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">{t("previews.none")}</p>
      ) : (
        <BoundedItems
          items={items}
          getKey={(p) => String(p.pr)}
          collapseId="branches.previews"
          title={t("previews.count", { count: items.length })}
          renderItem={(p) => (
            <div className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
              <span className="font-medium">#{p.pr}</span>
              <code className="text-xs">{p.sha.slice(0, 10)}</code>
              {p.fork ? <Badge>{t("previews.fork")}</Badge> : null}
              {p.held ? <Badge variant="warning">{t("previews.held")}</Badge> : null}
              {p.url ? <a className="underline break-all" href={p.url} target="_blank" rel="noreferrer noopener">{p.slug}</a> : null}
              <span className="text-xs text-muted">{t("previews.expires", { at: formatDateTime(p.expires_at) })}</span>
              <span className="ml-auto flex gap-2">
                {p.held && can("app.git.manage") === true ? (
                  <Button size="sm" variant="secondary" onClick={() => { setWithEnv(false); setApproving(p); }}>{t("previews.approve")}</Button>
                ) : null}
                {can("app.deploy") === true ? (
                  <Button size="sm" variant="ghost" aria-label={t("previews.delete", { pr: p.pr })} onClick={() => setDeleting(p)}>{t("previews.deleteShort")}</Button>
                ) : null}
              </span>
            </div>
          )}
        />
      )}

      <Dialog open={approving !== null} onOpenChange={(o) => !o && setApproving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("previews.approveTitle", { pr: approving?.pr })}</DialogTitle>
            <DialogDescription>{t("previews.approveHint", { sha: approving?.sha })}</DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={withEnv} onChange={(e) => setWithEnv(e.target.checked)} />
            {t("previews.withEnv")}
          </label>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setApproving(null)}>{t("cancel")}</Button>
            <Button disabled={approve.isPending} onClick={() => {
              if (approving) approve.mutate({ pr: approving.pr, sha: approving.sha, with_env: withEnv }, { onSettled: () => setApproving(null) });
            }}>{t("previews.approveConfirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("previews.deleteTitle", { pr: deleting?.pr })}</DialogTitle>
            <DialogDescription>{t("previews.deleteHint")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeleting(null)}>{t("cancel")}</Button>
            <Button variant="danger" disabled={remove.isPending} onClick={() => {
              if (deleting) remove.mutate(deleting.pr, { onSettled: () => setDeleting(null) });
            }}>{t("previews.deleteShort")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
