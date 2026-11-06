import { Check, CircleAlert, CircleCheck, ExternalLink, GitBranch, Plus, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { QueryError } from "@/components/features/empty/query-error";
import { useAppDetail } from "@/components/features/deployments/use-versions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { CopyButton } from "@/components/ui/url-bar";
import { useCan } from "@/hooks/authz";
import { formatDateTime, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

import { Link } from "@tanstack/react-router";

import { useVersions } from "@/components/features/deployments/use-versions";

import { NewBranchDialog } from "./new-branch-dialog";
import {
  type Branch,
  type Switch,
  type SwitchState,
  isActive,
  useBranches,
  useDeleteBranch,
  usePreflight,
  useSwitch,
  useSwitchStatus,
  stepStates,
  type StepState,
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

// BranchesView lists an app's branches; switches and rollbacks are rows of Deployments. The server authorizes every call;
// useCan only hides controls a role cannot use.
export function BranchesView({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation(["branches", "common", "operator"]);
  const branches = useBranches(org, app);
  const detail = useAppDetail(org, app);
  const deploy = useCan(org, detail.data?.project)("app.deploy") === true;
  const [target, setTarget] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Branch | null>(null);
  const remove = useDeleteBranch(org, app);
  const versions = useVersions(org, app);
  const liveDigest = versions.data?.find((v) => v.live)?.source_digest ?? null;

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
        actions={deploy ? <Button onClick={() => setCreating(true)}><Plus aria-hidden="true" /> {t("operator:branch.new")}</Button> : undefined}
      />
      {branches.data.length === 0 ? (
        <EmptyState entity="versions" title={t("emptyTitle")} description={t("operator:branch.empty")} />
      ) : (
        <BranchTable org={org} items={branches.data} deploy={deploy} liveDigest={liveDigest} onSwitch={setTarget} onDelete={setDeleting} />
      )}
      {creating ? <NewBranchDialog org={org} app={app} onClose={() => setCreating(false)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("deleteTitle", { name: deleting?.name })}
        description={t("deleteHint")}
        confirmLabel={t("delete")}
        typedValue={deleting?.name ?? ""}
        pending={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.slug, { onSuccess: () => setDeleting(null) });
        }}
      />
      {target !== null ? (
        <SwitchDialog org={org} app={app} branch={target} etag={detail.data?.etag} onClose={() => setTarget(null)} />
      ) : null}
    </section>
  );
}

// Below md each row stacks into a card, so the URL stays readable and Switch stays on screen.
export const STACK_ON_MOBILE =
  "max-md:[&_thead]:hidden max-md:[&_tbody]:block max-md:[&_tr]:block max-md:[&_tr]:border-b max-md:[&_tr]:border-line max-md:[&_tr]:py-2 max-md:[&_td]:block max-md:[&_td]:py-1";

function BranchTable({ org, items, deploy, liveDigest, onSwitch, onDelete }: { org: string; items: Branch[]; deploy: boolean; liveDigest: string | null; onSwitch: (name: string) => void; onDelete: (b: Branch) => void }) {
  const { t } = useTranslation(["branches", "common", "operator"]);
  const columns: DataColumn<Branch>[] = [
    {
      key: "branch",
      header: t("table.branch"),
      primary: true,
      sortValue: (b) => b.name,
      cell: (b) => (
        <>
          <Link to="/$org/apps/$app" params={{ org, app: b.slug }} aria-label={t("operator:branch.open", { name: b.name })} className="font-medium hover:underline">
            {b.name}
          </Link>
          <span className="block text-xs font-normal text-muted">{b.slug}</span>
        </>
      ),
    },
    {
      key: "url",
      header: t("table.url"),
      primary: true,
      cell: (b) => (
        <>
          <span className="inline-flex items-center gap-1">
            <a href={b.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-start gap-1 break-all font-mono text-xs text-accent hover:underline">
              {b.url}
              <ExternalLink aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
            </a>
            <CopyButton text={b.url} label={t("copyUrlFor", { name: b.name })} />
          </span>
          {b.access === "key" ? (
            <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
              {t("operator:branch.needsKey")}
              <Button
                variant="secondary"
                size="sm"
                className="h-6 px-2 text-xs"
                aria-label={t("operator:branch.copyCurlFor", { name: b.name })}
                onClick={() => void navigator.clipboard?.writeText(`curl -H "Authorization: Bearer $RT_KEY" ${b.url}`)}
              >
                {t("operator:branch.copyCurl")}
              </Button>
              <Link to="/$org/settings/tokens" params={{ org }} className="underline">{t("operator:branch.getKey")}</Link>
            </span>
          ) : null}
        </>
      ),
    },
    {
      key: "build",
      header: t("table.build"),
      cell: (b) => (
        <span className="inline-flex items-center gap-2 whitespace-nowrap">
          <Badge variant={BUILD_VARIANT[b.build_state] ?? "outline"} dot>
            {t(`state.${buildKey(b.build_state)}`)}
          </Badge>
          {b.live_version !== null ? <span className="text-xs tabular-nums text-muted">v{b.live_version}</span> : null}
        </span>
      ),
    },
    { key: "sha", header: t("table.sha"), cell: (b) => <span className="font-mono text-xs">{b.digest ? shortSha(b.digest) : t("noSha")}</span> },
    {
      key: "expires",
      header: t("table.expires"),
      align: "right",
      sortValue: (b) => b.expires_at ?? Number.MAX_SAFE_INTEGER,
      cell: (b) => <span className="text-muted">{b.expires_at ? formatDateTime(b.expires_at) : t("never")}</span>,
    },
    {
      key: "actions",
      header: t("common:actions"),
      align: "right",
      cell: (b) =>
        deploy ? (
          <span className="inline-flex items-center justify-end gap-2">
            {b.digest !== null && b.digest === liveDigest ? (
              <Badge variant="info">{t("operator:branch.alreadyLive")}</Badge>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                aria-label={t("switchFor", { name: b.name })}
                disabled={b.live_version === null || b.build_state !== "ready"}
                onClick={() => onSwitch(b.name)}
              >
                {t("switch")}
              </Button>
            )}
            <Button variant="ghost" size="sm" aria-label={t("deleteFor", { name: b.name })} onClick={() => onDelete(b)}>
              {t("delete")}
            </Button>
          </span>
        ) : null,
    },
  ];
  return (
    <DataTable
      label={t("title")}
      columns={columns}
      rows={items}
      rowKey={(b) => b.slug}
      count={t("count", { count: items.length })}
    />
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
  if (code === "replaces_with_starter") return t("warning.replaces_with_starter");
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
  const review =
    (env.length ? 1 : 0) + (triggers.length ? 1 : 0) + (data.pending_migrations?.length ? 1 : 0) + others.length;
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{t("preflight.heading")}</h3>
      <p
        role="status"
        className={cn(
          "flex items-center gap-2 rounded-md px-3 py-2 text-sm",
          review ? "bg-tag-yellow-bg text-tag-yellow-text" : "bg-tag-green-bg text-tag-green-text",
        )}
      >
        {review ? <CircleAlert aria-hidden="true" className="size-4 shrink-0" /> : <CircleCheck aria-hidden="true" className="size-4 shrink-0" />}
        {review ? t("preflight.review", { count: review }) : t("preflight.clear")}
      </p>
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
        <p
          key={w.code}
          role={w.code === "replaces_with_starter" ? "alert" : "status"}
          className={cn("text-sm", w.code === "replaces_with_starter" && "rounded-md bg-tag-red-bg px-3 py-2 text-tag-red-text")}
        >
          <WarningText code={w.code} />
        </p>
      ))}
    </div>
  );
}

const STEP_KEYS = ["prepare", "migrate", "drain", "live"] as const;

const STEP_DOT: Record<StepState, string> = {
  todo: "border border-line-strong text-muted",
  current: "bg-accent text-on-primary",
  done: "bg-tag-green-bg text-tag-green-text",
  failed: "bg-tag-red-bg text-tag-red-text",
};

function Steps({ states }: { states: StepState[] }) {
  const { t } = useTranslation("branches");
  return (
    <ol className="flex items-start">
      {STEP_KEYS.map((key, i) => {
        const state = states[i] ?? "todo";
        return (
          <li
            key={key}
            aria-current={state === "current" ? "step" : undefined}
            className="relative flex min-w-0 flex-1 flex-col items-center gap-1 text-center"
          >
            {i > 0 ? (
              <span
                aria-hidden="true"
                className={cn("absolute right-1/2 top-3 h-px w-full", state === "todo" ? "bg-line" : "bg-line-strong")}
              />
            ) : null}
            <span className={cn("relative grid size-6 place-items-center rounded-full bg-surface text-xs tabular-nums", STEP_DOT[state])}>
              {state === "done" ? (
                <Check aria-hidden="true" className="size-3.5" />
              ) : state === "failed" ? (
                <X aria-hidden="true" className="size-3.5" />
              ) : (
                i + 1
              )}
            </span>
            <span className={cn("text-xs", state === "todo" ? "text-muted" : "text-text")}>{t(`progress.step.${key}`)}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function Progress({ org, app, id }: { org: string; app: string; id: string }) {
  const { t } = useTranslation("branches");
  const status = useSwitchStatus(org, app, id);
  if (!status.data) return <Skeleton className="h-16 w-full" />;
  const s = status.data;
  const steps = stepStates(s.state);
  const took = s.updated_at - s.created_at;
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <h3 className="text-sm font-medium">{t("progress.heading")}</h3>
      {steps ? <Steps states={steps} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={STATE_VARIANT[s.state]} dot>
          {t(`switchState.${s.state}`)}
        </Badge>
        {!isActive(s.state) && took > 0 ? <span className="text-xs text-muted">{t("progress.took", { time: formatDuration(took) })}</span> : null}
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
