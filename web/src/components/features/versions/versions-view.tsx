import { useState } from "react";

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

const STATE_LABEL: Record<BuildState, string> = {
  pending: "Pending",
  building: "Building",
  ready: "Ready",
  failed: "Failed",
};

// VersionsView lists an app's versions newest first. Only ready versions can be promoted; failed ones
// can be rebuilt. Promote and rollback both go through a confirm dialog that names the target version.
export function VersionsView({ org, app }: { org: string; app: string }) {
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
        notFoundTitle="App not found"
        notFoundDescription="It may have been deleted or you lack access."
      />
    );
  }
  if (versions.isPending) return <Skeleton className="h-40 w-full" />;

  const items = versions.data;
  if (items.length === 0) {
    return (
      <EmptyState title="No versions yet" description="Save the app's code to create its first version." />
    );
  }

  const liveVersion = items.find((v) => v.live)?.version ?? detail.data?.live_version ?? null;
  const etag = detail.data?.etag;
  const target = promoteTarget;
  const isRollback = target !== null && liveVersion !== null && target.version < liveVersion;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="versions-heading">
      <h2 id="versions-heading" className="text-base font-semibold">
        Versions
      </h2>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead>Build</TableHead>
              <TableHead>Author</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((v) => {
              const rollback = liveVersion !== null && v.version < liveVersion;
              const verb = rollback ? "Roll back" : "Promote";
              return (
                <TableRow key={v.version}>
                  <TableCell className="font-medium">
                    v{v.version} {v.live ? <Badge>Live</Badge> : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{STATE_LABEL[v.build_state]}</Badge>
                  </TableCell>
                  <TableCell>{v.author ? v.author.name : "Outside the web"}</TableCell>
                  <TableCell className="text-muted">{new Date(v.created_at).toLocaleString()}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        variant="ghost"
                        aria-label={`Build log for version ${v.version}`}
                        onClick={() => setLogVersion(v.version)}
                      >
                        Build log
                      </Button>
                      {!v.live ? (
                        <Button
                          variant="ghost"
                          aria-label={`Diff version ${v.version} against live`}
                          onClick={() => setDiffVersion(v.version)}
                        >
                          Diff
                        </Button>
                      ) : null}
                      {deploy && v.build_state === "failed" ? (
                        <Button
                          variant="secondary"
                          aria-label={`Rebuild version ${v.version}`}
                          disabled={rebuild.isPending}
                          onClick={() =>
                            rebuild.mutate(v.version, { onSuccess: () => setLogVersion(v.version) })
                          }
                        >
                          Rebuild
                        </Button>
                      ) : null}
                      {deploy && !v.live ? (
                        <Button
                          variant="secondary"
                          aria-label={rollback ? `Roll back to version ${v.version}` : `Promote version ${v.version}`}
                          disabled={v.build_state !== "ready" || !etag}
                          onClick={() => setPromoteTarget(v)}
                        >
                          {verb}
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
              {isRollback ? `Roll back to version ${target?.version}?` : `Promote version ${target?.version} to live?`}
            </DialogTitle>
            <DialogDescription>
              {liveVersion === null
                ? `Version ${target?.version} becomes live for every visitor.`
                : `Version ${target?.version} replaces live version ${liveVersion} for every visitor.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setPromoteTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={promote.isPending || !etag}
              onClick={() => {
                if (!target || !etag) return;
                promote.mutate({ version: target.version, etag }, { onSuccess: () => setPromoteTarget(null) });
              }}
            >
              {isRollback ? "Roll back" : "Promote"}
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
  const log = useBuildLog(org, app, version ?? 0, version !== null);
  return (
    <Dialog open={version !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Build log, version {version}</DialogTitle>
        </DialogHeader>
        {log.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : log.isError ? (
          <p className="text-sm text-muted">The build log could not be loaded.</p>
        ) : log.data.length === 0 ? (
          <p className="text-sm text-muted">No build output.</p>
        ) : (
          <ol aria-label="Build log lines" className="max-h-[50vh] overflow-auto font-mono text-xs">
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
          <DialogTitle>Version {version} compared with live</DialogTitle>
        </DialogHeader>
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted">No differences from live.</p>
        ) : (
          <ul className="flex max-h-[50vh] flex-col gap-1 overflow-auto text-sm">
            {rows.map((r) => (
              <li key={r.path} className="flex items-center justify-between gap-2">
                <span className="break-all font-mono">{r.path}</span>
                <Badge variant="outline">{r.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
