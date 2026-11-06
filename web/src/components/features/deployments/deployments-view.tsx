import { ArrowLeftRight, ChevronDown, Download, History } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Progress } from "@/components/features/branches/branches-view";
import { RollbackChecklist } from "@/components/features/branches/rollback-checklist";
import { download } from "@/lib/export";

import { EventsPanel } from "./events-panel";
import { filterHistory, mergeHistory, switchDuration, versionSource, type DeploymentFilters, type HistoryRow, type PeriodFilter, type SourceFilter, type StateFilter } from "./history";
import { lineDiff } from "./line-diff";
import { useSwitchStatus, type Switch, type SwitchState } from "@/components/features/branches/use-branches";
import { PageHeader } from "@/components/ui/page-header";
import { i18n } from "@/lib/i18n";

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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { ExportMenu } from "@/components/ui/export-menu";
import { NoData } from "@/components/ui/no-data";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatDateTime, formatDuration, formatRelative } from "@/lib/format";

import { migrationRefused, MigrationsCard, PromotePreflight } from "./migrations";

import {
  type BuildState,
  type Version,
  useAppDetail,
  useBuildLog,
  useFiles,
  useDryRun,
  useMigrations,
  usePromote,
  usePromoteSettled,
  useRebuild,
  useSwitchHistory,
  useVersions,
} from "./use-versions";

const STATE_VARIANT: Record<BuildState, "success" | "danger" | "warning"> = {
  fetching: "warning",
  pending: "warning",
  building: "warning",
  ready: "success",
  failed: "danger",
};

const SWITCH_VARIANT: Record<SwitchState, "success" | "danger" | "warning"> = {
  preparing: "warning",
  migrating: "warning",
  draining: "warning",
  completed: "success",
  drain_timed_out: "warning",
  failed: "danger",
};

const ALL = "all";

// DeploymentsView is the app's one history: versions and the switches between them, newest first. Only ready versions
// can be promoted; failed ones can be rebuilt. Promote and rollback go through a confirm dialog naming the target.
// `filters` comes from the URL on the page; without it the filters stay local.
export function DeploymentsView({
  org,
  app,
  filters,
  onFiltersChange,
}: {
  org: string;
  app: string;
  filters?: DeploymentFilters;
  onFiltersChange?: (next: DeploymentFilters) => void;
}) {
  const { t } = useTranslation(["versions", "common", "platform"]);
  const versions = useVersions(org, app);
  const switches = useSwitchHistory(org, app);
  const [now] = useState(() => Date.now());
  const [ownFilters, setOwnFilters] = useState<DeploymentFilters>({});
  const active = filters ?? ownFilters;
  const setFilters = onFiltersChange ?? setOwnFilters;
  const detail = useAppDetail(org, app);
  const promote = usePromote(org, app);
  const rebuild = useRebuild(org, app);
  const deploy = useCan(org, detail.data?.project)("app.deploy") === true;
  const [promoteTarget, setPromoteTargetRaw] = useState<Version | null>(null);
  const [switchId, setSwitchId] = useState<string | null>(null);
  const [closeSockets, setCloseSockets] = useState(false);
  const setPromoteTarget = (v: Version | null) => {
    setPromoteTargetRaw(v);
    if (v === null) {
      setSwitchId(null);
      setCloseSockets(false);
    }
  };
  const migrations = useMigrations(org, app);
  const pendingNames = migrations.data?.pending_for_latest.map((m) => m.name) ?? [];
  const dryRun = useDryRun(
    org,
    app,
    promoteTarget?.version ?? null,
    pendingNames.length > 0 && promoteTarget !== null && (detail.data?.live_version ?? 0) < promoteTarget.version,
  );
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
  if (versions.isPending) return <DataTable label={t("title")} columns={[{ key: "a", header: t("table.version"), cell: () => null }, { key: "b", header: t("table.state"), cell: () => null }, { key: "c", header: t("common:created"), cell: () => null }]} rows={[]} rowKey={() => ""} loading />;

  const items = versions.data;
  if (items.length === 0) {
    return <EmptyState entity="versions" title={t("emptyTitle")} description={t("emptyDescription")} />;
  }

  const liveVersion = items.find((v) => v.live)?.version ?? detail.data?.live_version ?? null;
  const etag = detail.data?.etag;
  const target = promoteTarget;
  const isRollback = target !== null && liveVersion !== null && target.version < liveVersion;
  const needsCheck = target !== null && !isRollback && pendingNames.length > 0;

  const rows = filterHistory(mergeHistory(items, switches.data ?? []), active, now);
  const pendingCount = migrations.data?.pending_for_latest.length ?? 0;
  const hasMigrations = pendingCount > 0 || (migrations.data?.applied.length ?? 0) > 0;
  const setFilter = <K extends keyof DeploymentFilters>(key: K, value: string) => {
    const next = { ...active };
    if (value === ALL) delete next[key];
    else next[key] = value as DeploymentFilters[K];
    setFilters(next);
  };

  const versionActions = (v: Version) => {
    const rollback = liveVersion !== null && v.version < liveVersion;
    return (
      <div className="flex flex-wrap justify-end gap-1">
        <Button variant="ghost" size="sm" aria-label={t("buildLogFor", { version: v.version })} onClick={() => setLogVersion(v.version)}>
          {t("buildLog")}
        </Button>
        {!v.live ? (
          <Button variant="ghost" size="sm" aria-label={t("diffFor", { version: v.version })} onClick={() => setDiffVersion(v.version)}>
            {t("diff")}
          </Button>
        ) : null}
        {deploy && v.build_state === "failed" ? (
          <Button
            variant="secondary"
            size="sm"
            aria-label={t("rebuildFor", { version: v.version })}
            disabled={rebuild.isPending}
            onClick={() => rebuild.mutate(v.version, { onSuccess: () => setLogVersion(v.version) })}
          >
            {t("rebuild")}
          </Button>
        ) : null}
        {deploy && !v.live ? (
          <Button
            variant="secondary"
            size="sm"
            aria-label={rollback ? t("rollbackFor", { version: v.version }) : t("promoteFor", { version: v.version })}
            disabled={v.build_state !== "ready" || !etag}
            onClick={() => setPromoteTarget(v)}
          >
            {rollback ? t("rollback") : t("promote")}
          </Button>
        ) : null}
      </div>
    );
  };

  // A version made by a switch has no author or git commit of its own: its source is the version it was switched from.
  const switchedFrom = (r: HistoryRow): number | null => {
    if (r.type === "switch") return r.item.source?.version ?? null;
    if (versionSource(r.version).kind !== "api") return null;
    return (switches.data ?? []).find((s) => s.to_version === r.version.version && s.source)?.source?.version ?? null;
  };

  const columns: DataColumn<HistoryRow>[] = [
    {
      key: "version",
      header: t("table.version"),
      primary: true,
      cell: (r) =>
        r.type === "version" ? (
          <span className="font-medium">
            {t("versionLabel", { version: r.version.version })} {r.version.live ? <Badge variant="info">{t("live")}</Badge> : null}
          </span>
        ) : (
          <SwitchTitle item={r.item} />
        ),
    },
    {
      key: "state",
      header: t("table.state"),
      cell: (r) =>
        r.type === "version" ? (
          <Badge variant={STATE_VARIANT[r.version.build_state]} dot>
            {t(`state.${r.version.build_state}`)}
          </Badge>
        ) : (
          <Badge variant={SWITCH_VARIANT[r.item.state]} dot>
            {t(`switchState.${r.item.state}`)}
          </Badge>
        ),
    },
    {
      key: "source",
      header: t("table.source"),
      title: (r) => {
        const from = switchedFrom(r);
        if (from !== null) return t("source.fromVersionHint", { version: from });
        if (r.type !== "version") return t("source.unknownHint");
        const src = versionSource(r.version);
        return src.kind === "git" ? [src.sha, src.ref].filter(Boolean).join(" ") : "";
      },
      cell: (r) => {
        const from = switchedFrom(r);
        if (from !== null) return t("source.fromVersion", { version: from });
        if (r.type !== "version") return <NoData inline />;
        const src = versionSource(r.version);
        return src.kind === "git" ? <code className="font-mono text-[13px]">{src.sha.slice(0, 7)}</code> : t(`source.${src.kind}`);
      },
    },
    {
      key: "author",
      header: t("table.author"),
      cell: (r) => (r.type === "version" && r.version.author ? r.version.author.name : <NoData inline />),
    },
    {
      key: "created",
      header: t("common:created"),
      align: "right",
      title: (r) => formatDateTime(r.at),
      cell: (r) => <span className="text-muted">{formatRelative(r.at)}</span>,
    },
    {
      key: "duration",
      header: t("table.duration"),
      align: "right",
      cell: (r) => {
        const ms = r.type === "switch" ? switchDuration(r.item) : null;
        return ms === null ? <NoData inline /> : formatDuration(ms);
      },
    },
    {
      key: "actions",
      header: t("common:actions"),
      align: "right",
      primary: true,
      cell: (r) => (r.type === "version" ? versionActions(r.version) : null),
    },
  ];

  return (
    <section className="flex flex-col gap-6" aria-labelledby="versions-heading">
      <PageHeader
        icon={History}
        entity="versions"
        title={<span id="versions-heading">{t("title")}</span>}
        description={t("description")}
      />
      {switches.isError ? (
        <p role="status" className="text-[13px] text-muted">
          {t("switchesError")}
        </p>
      ) : null}
      <DataTable
        label={t("title")}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.key}
        count={t("count", { count: rows.length })}
        toolbar={
          <>
            <FilterSelect label={t("filter.state")} value={active.state ?? ALL} onChange={(v) => setFilter("state", v)} options={(["ready", "building", "failed"] satisfies StateFilter[]).map((v) => ({ value: v, label: t(`state.${v}`) }))} allLabel={t("filter.allStates")} />
            <FilterSelect label={t("filter.source")} value={active.source ?? ALL} onChange={(v) => setFilter("source", v)} options={(["git", "console", "api"] satisfies SourceFilter[]).map((v) => ({ value: v, label: t(`source.${v}`) }))} allLabel={t("filter.allSources")} />
            <Segmented
              label={t("filter.period")}
              value={active.period ?? ALL}
              onChange={(v) => setFilter("period", v)}
              options={[{ value: ALL, label: t("filter.allTime") }, ...(["24h", "7d", "30d"] satisfies PeriodFilter[]).map((v) => ({ value: v, label: t(`filter.${v}`) }))]}
            />
            <ExportMenu formats={["csv"] as const} href={(f) => `/api/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}/versions?format=${f}`} />
          </>
        }
        empty={<EmptyState variant="no-range" title={t("noMatch")} />}
      />

      {hasMigrations && migrations.data ? (
        <Collapsible key={pendingCount > 0 ? "pending" : "settled"} defaultOpen={pendingCount > 0} className="flex flex-col gap-2">
          <CollapsibleTrigger className="group flex min-h-8 cursor-pointer items-center gap-1 rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <ChevronDown aria-hidden="true" className="size-4 text-muted transition-transform group-data-[state=closed]:-rotate-90" />
            {t("migrationsToggle", { count: pendingCount })}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <MigrationsCard migrations={migrations.data} />
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      <EventsPanel org={org} app={app} hideSwitches />

      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (open) return;
          setPromoteTarget(null);
          setSwitchId(null);
          setCloseSockets(false);
        }}
      >
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
          {switchId ? (
            <>
              <PromoteProgress org={org} app={app} id={switchId} version={target?.version ?? 0} />
              <DialogFooter>
                <Button variant="secondary" onClick={() => setPromoteTarget(null)}>
                  {t("common:close")}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              {pendingNames.length > 0 && !isRollback ? <PromotePreflight check={dryRun} /> : null}
              {isRollback && target ? <RollbackChecklist org={org} app={app} version={target.version} /> : null}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={closeSockets} onChange={(e) => setCloseSockets(e.target.checked)} />
                {t("platform:promote.closeSockets")}
              </label>
              <DialogFooter>
                <Button variant="secondary" onClick={() => setPromoteTarget(null)}>
                  {t("common:cancel")}
                </Button>
                <Button
                  disabled={promote.isPending || !etag || (needsCheck && (dryRun.isPending || migrationRefused(dryRun.error)))}
                  onClick={() => {
                    if (!target || !etag) return;
                    promote.mutate({ version: target.version, etag, closeSockets }, { onSuccess: (s) => setSwitchId(s.id) });
                  }}
                >
                  {isRollback ? t("rollback") : t("promote")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <BuildLogDialog org={org} app={app} version={logVersion} onClose={() => setLogVersion(null)} />
      <DiffDialog org={org} app={app} version={diffVersion} onClose={() => setDiffVersion(null)} />
    </section>
  );
}

// PromoteProgress follows the switch; closing the dialog leaves it running. The new version serves from draining on.
function PromoteProgress({ org, app, id, version }: { org: string; app: string; id: string; version: number }) {
  const { t } = useTranslation("platform");
  const status = useSwitchStatus(org, app, id);
  const settled = usePromoteSettled(org, app);
  const state = status.data?.state;
  const done = state !== undefined && state !== "preparing" && state !== "migrating";
  useEffect(() => {
    if (!done) return;
    settled();
    if (state === "failed") toast.error(t("promote.failed", { version }));
    else toast.success(i18n.t("versions:toast.live", { version }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per finished switch
  }, [done]);
  return (
    <>
      {!done ? <p className="text-sm text-muted" role="status">{t(state === "migrating" ? "promote.migrating" : "promote.preparing")}</p> : null}
      <Progress org={org} app={app} id={id} />
    </>
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
    <Sheet open={version !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-3 p-4 sm:max-w-2xl">
        <SheetHeader className="p-0">
          <SheetTitle>{t("buildLogTitle", { version: version ?? "" })}</SheetTitle>
          <SheetDescription className="sr-only">{t("buildLogLines")}</SheetDescription>
        </SheetHeader>
        {log.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : log.isError ? (
          <p className="text-sm text-muted">{t("buildLogError")}</p>
        ) : log.data.length === 0 ? (
          <p className="text-sm text-muted">{t("buildLogEmpty")}</p>
        ) : (
          <>
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => download(`${org}-${app}-build-v${version}.txt`, log.data.map((l) => l.msg).join("\n"), "text/plain;charset=utf-8")}
              >
                <Download aria-hidden="true" /> {t("buildLogExport")}
              </Button>
            </div>
            <ol aria-label={t("buildLogLines")} className="min-h-0 flex-1 overflow-auto rounded-md bg-canvas-inset p-2 font-mono text-xs">
              {log.data.map((l) => (
                <li key={l.seq} className="break-all py-0.5">
                  <span>{l.msg}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// A switch or rollback, inline between the versions it moved between.
function SwitchTitle({ item }: { item: Switch }) {
  const { t } = useTranslation("versions");
  const from = item.from_version;
  const to = item.to_version;
  const title = to === null ? t(`switchKind.${item.kind}`) : from === null ? t("switchMadeLive", { to }) : t(`switchTitle.${item.kind}`, { from, to });
  return (
    <span className="flex min-w-0 flex-col text-muted">
      <span className="flex items-center gap-1.5">
        <ArrowLeftRight aria-hidden="true" className="size-3.5 shrink-0" />
        {title}
      </span>
      {item.error ? <span className="text-[12px] text-danger-text">{item.error}</span> : null}
    </span>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly { value: string; label: string }[];
  allLabel: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="h-8 w-auto min-w-32 shadow-none">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// LineChanges: what this version has against live. Unchanged lines are dropped to keep it short.
function LineChanges({ before, after }: { before: string; after: string }) {
  const { t } = useTranslation("operator");
  const lines = lineDiff(before, after);
  if (lines === null) return <p className="text-xs text-muted">{t("diffTooLarge")}</p>;
  return (
    <pre className="overflow-x-auto rounded bg-panel-2 p-2 font-mono text-xs">
      {lines.filter((l) => l.kind !== "same").map((l, i) => (
        <div key={i} className={l.kind === "add" ? "text-tag-green-text" : "text-tag-red-text"}>
          {l.kind === "add" ? "+ " : "- "}{l.text}
        </div>
      ))}
    </pre>
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
              <li key={r.path} className="flex flex-col gap-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="break-all font-mono">{r.path}</span>
                  <Badge variant="outline">{t(`diffStatus.${r.status}`)}</Badge>
                </span>
                {r.status === "changed" ? (
                  <LineChanges before={live.data?.files[r.path] ?? ""} after={candidate.data?.files[r.path] ?? ""} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
