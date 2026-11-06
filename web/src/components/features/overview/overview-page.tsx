import { Link } from "@tanstack/react-router";
import { AlertTriangle, ChevronDown, History, Rocket } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useAppView } from "@/components/features/app-header/hooks";
import { AppPreview } from "@/components/features/editor/app-preview";
import { useFiles } from "@/components/features/editor/hooks";
import { QueryError } from "@/components/features/empty/query-error";
import { eventNote, groupEvents, groupTitle } from "@/components/features/deployments/event-text";
import { useVersions } from "@/components/features/deployments/use-versions";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { EmptyState } from "@/components/ui/empty-state";
import { StatTile } from "@/components/ui/page-header";
import { SectionCard, SMALL_CONTROL } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Timeline, type TimelineItem } from "@/components/ui/timeline";
import { formatCount, formatDateTime, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

import { BuildBadge } from "./apps-table";
import { FirstRun } from "./first-run";
import { useAppEvents, useAppStats } from "./hooks";

const ACTIVITY_ITEMS = 5;
const LINK = "text-[13px] text-muted hover:text-text hover:underline";

function PreviewCard({ org, app, url }: { org: string; app: string; url: string }) {
  const { t } = useTranslation("overview");
  // Collapsed on a phone, where the frame would push the figures off the first screen and spend a request unasked.
  const [open, setOpen] = useState(() => !window.matchMedia("(max-width: 767px)").matches);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2">
      <CollapsibleTrigger className="flex min-h-8 cursor-pointer items-center gap-1.5 self-start rounded-sm text-[15px] font-semibold text-text outline-none focus-visible:ring-2 focus-visible:ring-focus">
        <ChevronDown aria-hidden="true" className={cn("size-4 text-muted transition-transform", !open && "-rotate-90")} />
        {t("preview")}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2">
        <AppPreview org={org} app={app} url={url} title={t("preview")} className="h-[200px]" />
      </CollapsibleContent>
    </Collapsible>
  );
}

function LastHour({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation(["overview", "common"]);
  const stats = useAppStats(org, app, "1h");
  const links = (
    <span className="flex gap-3">
      <Link to="/$org/apps/$app/analytics" params={{ org, app }} className={LINK}>
        {t("stats.viewAnalytics")}
      </Link>
      <Link to="/$org/apps/$app/logs" params={{ org, app }} className={LINK}>
        {t("stats.viewLogs")}
      </Link>
    </span>
  );
  const na = t("common:na");
  const d = stats.data;
  return (
    <SectionCard title={t("stats.title")} actions={links}>
      {stats.isError ? (
        <QueryError error={stats.error} onRetry={() => void stats.refetch()} notFoundTitle={t("stats.notFound")} />
      ) : stats.isPending ? (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[72px]" />
          ))}
        </div>
      ) : !d?.requests ? (
        <p className="text-sm text-muted">{t("stats.noRequests")}</p>
      ) : (
        <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <StatTile label={t("stats.requests")} value={formatCount(d.requests)} />
          <StatTile label={t("stats.errors")} value={typeof d.errors === "number" ? formatCount(d.errors) : na} />
          <StatTile label={t("stats.p95")} value={typeof d.p95_ms === "number" ? `${formatCount(d.p95_ms)} ms` : na} />
          <StatTile label={t("stats.errorRate")} value={typeof d.error_rate === "number" ? `${(d.error_rate * 100).toFixed(1)}%` : na} />
        </dl>
      )}
    </SectionCard>
  );
}

function LastDeployment({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation("overview");
  const versions = useVersions(org, app);
  const last = [...(versions.data ?? [])].sort((a, b) => b.version - a.version)[0];
  return (
    <SectionCard
      className="h-full"
      title={t("lastDeployment.title")}
      actions={
        <Link to="/$org/apps/$app/deployments" params={{ org, app }} className={SMALL_CONTROL}>
          {t("lastDeployment.all")}
        </Link>
      }
    >
      {versions.isError ? (
        <QueryError error={versions.error} onRetry={() => void versions.refetch()} notFoundTitle={t("lastDeployment.title")} />
      ) : versions.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : !last ? (
        <EmptyState bare entity="versions" icon={History} title={t("lastDeployment.emptyTitle")} description={t("lastDeployment.emptyDescription")} />
      ) : (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted">{t("lastDeployment.version")}</dt>
          <dd className="flex items-center gap-2 tabular-nums">
            <span>{`v${last.version}`}</span>
            {last.live ? <Badge variant="blue">{t("lastDeployment.live")}</Badge> : null}
          </dd>
          <dt className="text-muted">{t("lastDeployment.state")}</dt>
          <dd>
            <BuildBadge state={last.build_state} />
          </dd>
          <dt className="text-muted">{t("lastDeployment.author")}</dt>
          <dd className="truncate">{last.author ? last.author.name : t("lastDeployment.outside")}</dd>
          <dt className="text-muted">{t("lastDeployment.created")}</dt>
          <dd title={formatDateTime(last.created_at)}>{formatRelative(last.created_at)}</dd>
        </dl>
      )}
    </SectionCard>
  );
}

function Activity({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation(["overview", "common"]);
  const events = useAppEvents(org, app);
  const groups = groupEvents(events.data?.pages.flatMap((p) => p.items) ?? []).slice(0, ACTIVITY_ITEMS);
  const items: TimelineItem[] = groups.map((g) => {
    const failed = g.change ? g.change.failed : /fail/.test(g.events[0]?.kind ?? "");
    const first = g.events[0];
    const note = g.change || !first ? null : eventNote(first);
    return {
      id: g.key,
      icon: failed ? AlertTriangle : g.change ? Rocket : History,
      hue: failed ? "red" : g.change ? "blue" : "gray",
      title: groupTitle(g),
      at: g.ts,
      ...(note ? { actor: note } : {}),
    };
  });
  return (
    <SectionCard
      className="h-full"
      title={t("activity.title")}
      actions={
        <Link to="/$org/apps/$app/deployments" params={{ org, app }} className={SMALL_CONTROL}>
          {t("common:viewAll")}
        </Link>
      }
    >
      {events.isError ? (
        <QueryError error={events.error} onRetry={() => void events.refetch()} notFoundTitle={t("events.notFound")} />
      ) : events.isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState bare entity="audit" icon={History} title={t("events.emptyTitle")} description={t("events.emptyDescription")} />
      ) : (
        <Timeline items={items} />
      )}
    </SectionCard>
  );
}

// OverviewPage answers "is this app fine": preview, the last hour, the last deployment and recent activity. The app
// header above it holds the identity and the URL.
export function OverviewPage({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation("overview");
  const view = useAppView(org, app);
  const files = useFiles(org, app);

  if (view.isError) {
    return <QueryError error={view.error} onRetry={() => void view.refetch()} notFoundTitle={t("app.notFound")} />;
  }
  if (view.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton className="h-[200px] w-full" />
        <Skeleton className="h-28 w-full" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      </div>
    );
  }

  const a = view.data;
  return (
    <div className="flex flex-col gap-4">
      {a.status.last_error ? (
        <p role="note" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger-text">
          {t("lastError", { error: a.status.last_error })}
        </p>
      ) : null}
      <PreviewCard org={org} app={app} url={a.url} />
      {a.live_version !== null && a.live_version <= 1 ? (
        <FirstRun org={org} app={app} url={a.url} access={a.access} source={files.data ? files.data.files[files.data.entry] : undefined} />
      ) : null}
      <LastHour org={org} app={app} />
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <LastDeployment org={org} app={app} />
        <Activity org={org} app={app} />
      </div>
    </div>
  );
}
