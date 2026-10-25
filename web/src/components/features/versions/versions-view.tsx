import { History } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/ui/page-header";

import { QueryError } from "@/components/features/empty/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCan } from "@/hooks/authz";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";

import {
  type BuildState,
  type Version,
  useAppDetail,
  useBuildLog,
  useFiles,
  usePromote,
  useRebuild,
  useVersions,
} from "./use-versions";

const STATE_VARIANT: Record<BuildState, "success" | "danger" | "warning"> = {
  pending: "warning",
  building: "warning",
  ready: "success",
  failed: "danger",
};

// VersionsView lists an app's versions newest first. Only ready versions can be promoted; failed ones
// can be rebuilt. Promote and rollback both go through a confirm dialog that names the target version.
export function VersionsView({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation(["versions", "common"]);
  const versions = useVersions(org, app);
  const detail = useAppDetail(org, app);
  const promote = usePromote(org, app);
  const rebuild = useRebuild(org, app);
  const deploy = useCan(org, detail.data?.project)("app.deploy") === true;
  const [promoteTarget, setPromoteTarget] = useState<Version | null>(null);
  const [logVersion, setLogVersion] = useState<number | null>(null);
  const [diffVersion, setDiffVersion] = useState<number | null>(null);

  if (versions.isError) {
    return (
      <QueryError
        error={versions.error}
        onRetry={() => void versions.refetch()}
        notFoundTitle={t("notFound")}
        notFoundDescription={t("notFoundDescription")}
      />
    );
  }
  if (versions.isPending) return <Skeleton className="h-40 w-full" />;

  const items = versions.data;
  if (items.length === 0) {
    return <EmptyState entity="versions" title={t("emptyTitle")} description={t("emptyDescription")} />;
  }

  const liveVersion = items.find((v) => v.live)?.version ?? detail.data?.live_version ?? null;
  const etag = detail.data?.etag;
  const target = promoteTarget;
  const isRollback = target !== null && liveVersion !== null && target.version < liveVersion;

  return (
    <section className="flex flex-col gap-6" aria-labelledby="versions-heading">
      <PageHeader
        icon={History}
        entity="versions"
        title={<span id="versions-heading">{t("title")}</span>}
        description={t("description")}
      />
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("table.version")}</TableHead>
              <TableHead>{t("table.build")}</TableHead>
              <TableHead>{t("table.author")}</TableHead>
              <TableHead>{t("common:created")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("common:actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((v) => {
              const rollback = liveVersion !== null && v.version < liveVersion;
              return (
                <TableRow key={v.version}>
                  <TableCell className="font-medium">
                    {t("versionLabel", { version: v.version })}{" "}
                    {v.live ? <Badge variant="info">{t("live")}</Badge> : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATE_VARIANT[v.build_state]} dot>
                      {t(`state.${v.build_state}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>{v.author ? v.author.name : t("outside")}</TableCell>
                  <TableCell className="text-muted">{formatDateTime(v.created_at)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        variant="ghost"
                        aria-label={t("buildLogFor", { version: v.version })}
                        onClick={() => setLogVersion(v.version)}
                      >
                        {t("buildLog")}
                      </Button>
                      {!v.live ? (
                        <Button
                          variant="ghost"
                          aria-label={t("diffFor", { version: v.version })}
                          onClick={() => setDiffVersion(v.version)}
                        >
                          {t("diff")}
                        </Button>
                      ) : null}
                      {deploy && v.build_state === "failed" ? (
                        <Button
                          variant="secondary"
                          aria-label={t("rebuildFor", { version: v.version })}
                          disabled={rebuild.isPending}
                          onClick={() =>
                            rebuild.mutate(v.version, { onSuccess: () => setLogVersion(v.version) })
                          }
                        >
                          {t("rebuild")}
                        </Button>
                      ) : null}
                      {deploy && !v.live ? (
                        <Button
                          variant="secondary"
                          aria-label={
                            rollback
                              ? t("rollbackFor", { version: v.version })
                              : t("promoteFor", { version: v.version })
                          }
                          disabled={v.build_state !== "ready" || !etag}
                          onClick={() => setPromoteTarget(v)}
                        >
                          {rollback ? t("rollback") : t("promote")}
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <Dialog open={target !== null} onOpenChange={(open) => !open && setPromoteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {isRollback
                ? t("rollbackTitle", { version: target?.version })
                : t("promoteTitle", { version: target?.version })}
            </DialogTitle>
            <DialogDescription>
              {liveVersion === null
                ? t("liveFirst", { version: target?.version })
                : t("liveReplace", { version: target?.version, live: liveVersion })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setPromoteTarget(null)}>
              {t("common:cancel")}
            </Button>
            <Button
              disabled={promote.isPending || !etag}
              onClick={() => {
                if (!target || !etag) return;
                promote.mutate({ version: target.version, etag }, { onSuccess: () => setPromoteTarget(null) });
              }}
            >
              {isRollback ? t("rollback") : t("promote")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BuildLogDialog org={org} app={app} version={logVersion} onClose={() => setLogVersion(null)} />
      <DiffDialog org={org} app={app} version={diffVersion} onClose={() => setDiffVersion(null)} />
    </section>
  );
}

function BuildLogDialog({
  org,
  app,
  version,
  onClose,
}: {
  org: string;
  app: string;
  version: number | null;
  onClose: () => void;
}) {
  const { t } = useTranslation(["versions", "common"]);
  const log = useBuildLog(org, app, version ?? 0, version !== null);
  return (
    <Dialog open={version !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("buildLogTitle", { version: version ?? "" })}</DialogTitle>
        </DialogHeader>
        {log.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : log.isError ? (
          <p className="text-sm text-muted">{t("buildLogError")}</p>
        ) : log.data.length === 0 ? (
          <p className="text-sm text-muted">{t("buildLogEmpty")}</p>
        ) : (
          <ol aria-label={t("buildLogLines")} className="max-h-[50vh] overflow-auto font-mono text-xs">
            {log.data.map((l) => (
              <li key={l.seq} className="break-all py-0.5">
                <span>{l.msg}</span>
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}

// DiffDialog lists files that differ between a version and the live version (added, removed, changed).
function DiffDialog({
  org,
  app,
  version,
  onClose,
}: {
  org: string;
  app: string;
  version: number | null;
  onClose: () => void;
}) {
  const { t } = useTranslation(["versions", "common"]);
  const open = version !== null;
  const candidate = useFiles(org, app, version ?? 0, open);
  const live = useFiles(org, app, undefined, open);
  const loading = candidate.isPending || live.isPending;

  let rows: { path: string; status: "added" | "removed" | "changed" }[] = [];
  if (!loading && candidate.data && live.data) {
    const a = candidate.data.files;
    const b = live.data.files;
    const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    rows = [];
    for (const path of paths) {
      if (!(path in b)) rows.push({ path, status: "added" });
      else if (!(path in a)) rows.push({ path, status: "removed" });
      else if (a[path] !== b[path]) rows.push({ path, status: "changed" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("diffTitle", { version: version ?? "" })}</DialogTitle>
        </DialogHeader>
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted">{t("diffEmpty")}</p>
        ) : (
          <ul className="flex max-h-[50vh] flex-col gap-1 overflow-auto text-sm">
            {rows.map((r) => (
              <li key={r.path} className="flex items-center justify-between gap-2">
                <span className="break-all font-mono">{r.path}</span>
                <Badge variant="outline">{t(`diffStatus.${r.status}`)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
