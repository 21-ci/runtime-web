import { GitBranch } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { QueryError } from "@/components/features/empty/query-error";
import { useAppDetail } from "@/components/features/versions/use-versions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCan } from "@/hooks/authz";
import { formatDateTime } from "@/lib/format";

import {
  type Branch,
  type Switch,
  type SwitchState,
  isActive,
  useBranches,
  usePreflight,
  useRollback,
  useSwitch,
  useSwitches,
  useSwitchStatus,
} from "./use-branches";

const BUILD_VARIANT: Record<string, "success" | "danger" | "warning" | "outline"> = {
  pending: "warning",
  building: "warning",
  ready: "success",
  failed: "danger",
};

const STATE_VARIANT: Record<SwitchState, "success" | "danger" | "warning"> = {
  preparing: "warning",
  migrating: "warning",
  draining: "warning",
  completed: "success",
  drain_timed_out: "danger",
  failed: "danger",
};

const BUILD_STATES = ["pending", "building", "ready", "failed"] as const;
const buildKey = (s: string) => (BUILD_STATES as readonly string[]).includes(s) ? (s as (typeof BUILD_STATES)[number]) : "none";

// The first 12 hex characters identify a build the way a short commit SHA does.
const shortSha = (digest: string) => digest.replace(/^sha256:/, "").slice(0, 12);

// BranchesView lists an app's branches and its switch history. The server authorizes every call;
// useCan only hides controls a role cannot use.
export function BranchesView({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation(["branches", "common"]);
  const branches = useBranches(org, app);
  const detail = useAppDetail(org, app);
  const deploy = useCan(org, detail.data?.project)("app.deploy") === true;
  const [target, setTarget] = useState<string | null>(null);

  if (branches.isError) {
    return (
      <QueryError
        error={branches.error}
        onRetry={() => void branches.refetch()}
        notFoundTitle={t("notFound")}
        notFoundDescription={t("notFoundDescription")}
      />
    );
  }
  if (branches.isPending) return <Skeleton className="h-40 w-full" />;

  return (
    <section className="flex flex-col gap-6" aria-labelledby="branches-heading">
      <PageHeader
        icon={GitBranch}
        entity="versions"
        title={<span id="branches-heading">{t("title")}</span>}
        description={t("description")}
      />
      {branches.data.length === 0 ? (
        <EmptyState entity="versions" title={t("emptyTitle")} description={t("emptyDescription")} />
      ) : (
        <BranchTable items={branches.data} deploy={deploy} onSwitch={setTarget} />
      )}
      <History org={org} app={app} deploy={deploy} etag={detail.data?.etag} />
      {target !== null ? (
        <SwitchDialog org={org} app={app} branch={target} etag={detail.data?.etag} onClose={() => setTarget(null)} />
      ) : null}
    </section>
  );
}

function BranchTable({ items, deploy, onSwitch }: { items: Branch[]; deploy: boolean; onSwitch: (name: string) => void }) {
  const { t } = useTranslation(["branches", "common"]);
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("table.branch")}</TableHead>
            <TableHead>{t("table.url")}</TableHead>
            <TableHead>{t("table.build")}</TableHead>
            <TableHead>{t("table.sha")}</TableHead>
            <TableHead>{t("table.expires")}</TableHead>
            <TableHead>
              <span className="sr-only">{t("common:actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((b) => (
            <TableRow key={b.slug}>
              <TableCell className="font-medium">
                {b.name}
                <span className="block text-xs font-normal text-muted">{b.slug}</span>
              </TableCell>
              <TableCell>
                <a href={b.url} target="_blank" rel="noopener noreferrer" className="break-all underline">
                  {b.url}
                </a>
              </TableCell>
              <TableCell>
                <Badge variant={BUILD_VARIANT[b.build_state] ?? "outline"} dot>
                  {t(`state.${buildKey(b.build_state)}`)}
                </Badge>
              </TableCell>
              <TableCell className="font-mono text-xs">{b.digest ? shortSha(b.digest) : t("noSha")}</TableCell>
              <TableCell className="text-muted">{b.expires_at ? formatDateTime(b.expires_at) : t("never")}</TableCell>
              <TableCell>
                {deploy ? (
                  <div className="flex justify-end">
                    <Button
                      variant="secondary"
                      aria-label={t("switchFor", { name: b.name })}
                      disabled={b.live_version === null || b.build_state !== "ready"}
                      onClick={() => onSwitch(b.name)}
                    >
                      {t("switch")}
                    </Button>
                  </div>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function NameList({ names }: { names: string[] }) {
  return (
    <ul className="flex flex-wrap gap-1">
      {names.map((n) => (
        <li key={n}>
          <Badge variant="outline">{n}</Badge>
        </li>
      ))}
    </ul>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-[13px] font-medium">{label}</dt>
      <dd className="text-sm text-muted">{children}</dd>
    </div>
  );
}

function WarningText({ code }: { code: string }) {
  const { t } = useTranslation("branches");
  return code === "routes_refresh_delayed" || code === "schedule_tick_skipped"
    ? t(`warning.${code}`)
    : t("warning.other", { code });
}

function Preflight({ data, branch }: { data: Switch; branch: string }) {
  const { t } = useTranslation("branches");
  const named = (code: string) => data.warnings.find((w) => w.code === code)?.names ?? [];
  const env = named("env_missing_on_parent");
  const triggers = named("triggers_differ");
  const others = data.warnings.filter((w) => w.code !== "env_missing_on_parent" && w.code !== "triggers_differ");
  const source = data.source?.version ?? 0;
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{t("preflight.heading")}</h3>
      <dl className="flex flex-col gap-3">
        <Row label={t("preflight.liveChange")}>
          {data.from_version === null
            ? t("preflight.liveFirstValue", { name: branch, source })
            : t("preflight.liveChangeValue", { from: data.from_version, name: branch, source })}
        </Row>
        <Row label={t("preflight.running")}>{data.inflight_old}</Row>
        <Row label={t("preflight.envMissing")}>{env.length ? <NameList names={env} /> : t("preflight.none")}</Row>
        <Row label={t("preflight.triggers")}>{triggers.length ? <NameList names={triggers} /> : t("preflight.none")}</Row>
        <Row label={t("preflight.migrations")}>
          {data.pending_migrations === null ? (
            t("preflight.migrationsUnknown")
          ) : data.pending_migrations.length ? (
            <NameList names={data.pending_migrations} />
          ) : (
            t("preflight.migrationsNone")
          )}
        </Row>
      </dl>
      {others.map((w) => (
        <p key={w.code} role="status" className="text-sm">
          <WarningText code={w.code} />
        </p>
      ))}
    </div>
  );
}

function Progress({ org, app, id }: { org: string; app: string; id: string }) {
  const { t } = useTranslation("branches");
  const status = useSwitchStatus(org, app, id);
  if (!status.data) return <Skeleton className="h-16 w-full" />;
  const s = status.data;
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      <h3 className="text-sm font-medium">{t("progress.heading")}</h3>
      <div>
        <Badge variant={STATE_VARIANT[s.state]} dot>
          {t(`switchState.${s.state}`)}
        </Badge>
      </div>
      {isActive(s.state) && s.inflight_old > 0 ? (
        <p className="text-sm">{t("progress.running", { count: s.inflight_old, version: s.from_version })}</p>
      ) : null}
      {isActive(s.state) && s.drain_deadline ? (
        <p className="text-sm text-muted">{t("progress.deadline", { time: formatDateTime(s.drain_deadline) })}</p>
      ) : null}
      {s.interrupted ? <p className="text-sm">{t("progress.interrupted")}</p> : null}
      {s.error ? <p className="text-sm">{t("progress.error", { code: s.error })}</p> : null}
      {s.warnings
        .filter((w) => w.code !== "env_missing_on_parent" && w.code !== "triggers_differ")
        .map((w) => (
          <p key={w.code} className="text-sm text-muted">
            <WarningText code={w.code} />
          </p>
        ))}
    </div>
  );
}

// SwitchDialog runs the dry run on open and only then allows the switch. After it starts, the dialog
// follows the switch; closing it leaves the switch running and the history keeps following.
function SwitchDialog({
  org,
  app,
  branch,
  etag,
  onClose,
}: {
  org: string;
  app: string;
  branch: string;
  etag: string | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation(["branches", "common"]);
  const preflight = usePreflight(org, app, branch);
  const start = useSwitch(org, app);
  const [closeSockets, setCloseSockets] = useState(false);
  const [running, setRunning] = useState<string | null>(null);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("switchTitle", { name: branch })}</DialogTitle>
          <DialogDescription>{t("switchHint")}</DialogDescription>
        </DialogHeader>
        {running !== null ? (
          <Progress org={org} app={app} id={running} />
        ) : preflight.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : preflight.isError ? (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-sm">
              {t("preflightError")}
            </p>
            <Button variant="secondary" onClick={() => void preflight.refetch()}>
              {t("retry")}
            </Button>
          </div>
        ) : (
          <>
            <Preflight data={preflight.data} branch={branch} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={closeSockets} onChange={(e) => setCloseSockets(e.target.checked)} />
              {t("preflight.closeSockets")}
            </label>
          </>
        )}
        <DialogFooter>
          {running !== null ? (
            <Button variant="secondary" onClick={onClose}>
              {t("progress.close")}
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose}>
                {t("common:cancel")}
              </Button>
              <Button
                disabled={!preflight.isSuccess || !etag || start.isPending}
                onClick={() => {
                  if (!etag) return;
                  start.mutate({ branch, closeSockets, etag }, { onSuccess: (res) => setRunning(res.id) });
                }}
              >
                {t("switch")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function History({ org, app, deploy, etag }: { org: string; app: string; deploy: boolean; etag: string | undefined }) {
  const { t } = useTranslation(["branches", "common"]);
  const switches = useSwitches(org, app);
  const rollback = useRollback(org, app);
  const [target, setTarget] = useState<Switch | null>(null);

  if (switches.isError) {
    return <QueryError error={switches.error} onRetry={() => void switches.refetch()} notFoundTitle={t("notFound")} notFoundDescription={t("notFoundDescription")} />;
  }
  if (switches.isPending) return <Skeleton className="h-24 w-full" />;

  // Going back only makes sense from the version that is live now: the newest flip that took effect.
  const latest = switches.data.find((s) => s.state !== "failed");

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-base font-medium">{t("history.title")}</h2>
      {switches.data.length === 0 ? (
        <p className="text-sm text-muted">{t("history.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("history.kind")}</TableHead>
                <TableHead>{t("history.change")}</TableHead>
                <TableHead>{t("history.state")}</TableHead>
                <TableHead>{t("common:created")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("common:actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {switches.data.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{t(`kind.${s.kind}`)}</TableCell>
                  <TableCell>
                    {s.from_version === null
                      ? t("history.first_value", { to: s.to_version })
                      : t("history.change_value", { from: s.from_version, to: s.to_version })}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATE_VARIANT[s.state]} dot>
                      {t(`switchState.${s.state}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted">{formatDateTime(s.created_at)}</TableCell>
                  <TableCell>
                    {deploy && s === latest && s.from_version !== null ? (
                      <div className="flex justify-end">
                        <Button
                          variant="secondary"
                          aria-label={t("rollbackFor", { version: s.from_version })}
                          disabled={!etag}
                          onClick={() => setTarget(s)}
                        >
                          {t("rollback")}
                        </Button>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title={t("rollbackTitle", { version: target?.from_version })}
        description={t("rollbackDescription", { version: target?.from_version })}
        confirmLabel={t("rollback")}
        pending={rollback.isPending}
        onConfirm={() => {
          if (!target?.id || !etag) return;
          rollback.mutate({ id: target.id, etag }, { onSuccess: () => setTarget(null) });
        }}
      />
    </div>
  );
}
