import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { QueryError } from "@/components/features/empty/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
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

/** `NAME=value` lines, the form the env editor uses. A line without `=` is dropped by the server's name check instead. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const at = line.indexOf("=");
    if (at < 0) out[line.trim()] = "";
    else out[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  return out;
}

export function PreviewsCard({ org, app, project, enabled, onToggle, toggling }: {
  org: string; app: string; project: string | undefined; enabled: boolean; onToggle: (v: boolean) => void; toggling: boolean;
}) {
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
      <label className="mb-4 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} disabled={toggling} onChange={(e) => onToggle(e.target.checked)} />
        {t("previews.enable")}
      </label>
      {list.isError ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} notFoundTitle={t("previews.title")} />
      ) : !items ? (
        <Skeleton className="h-16 w-full" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">{t("previews.none")}</p>
      ) : (
        <ul className="flex flex-col gap-3 text-sm">
          {items.map((p) => (
            <li key={p.pr} className="flex flex-wrap items-center gap-2">
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
            </li>
          ))}
        </ul>
      )}
      {can("app.env.write") === true ? <PreviewEnv org={org} app={app} /> : null}

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

function PreviewEnv({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation("platform");
  const [text, setText] = useState<string | null>(null);
  const env = useQuery({
    queryKey: ["preview-env", org, app],
    queryFn: () => api.get<{ env: Record<string, string> }>(`${base(org, app)}/preview-env`),
  });
  const save = useMutation({ mutationFn: (v: Record<string, string>) => api.put<null>(`${base(org, app)}/preview-env`, { env: v }) });
  const shown = text ?? Object.entries(env.data?.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
  return (
    <div className="mt-5 flex flex-col gap-2">
      <Label htmlFor="preview-env">{t("previews.env")}</Label>
      <textarea
        id="preview-env"
        value={shown}
        rows={4}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        className="rounded-sm border border-line-strong bg-surface p-2 font-mono text-sm text-text focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus"
      />
      <p className="text-xs text-muted">{t("previews.envHint")}</p>
      <div><Button size="sm" variant="secondary" disabled={save.isPending} onClick={() => save.mutate(parseEnv(shown))}>{t("previews.envSave")}</Button></div>
    </div>
  );
}
