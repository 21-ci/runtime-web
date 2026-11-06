import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { QueryError } from "@/components/features/empty/query-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBytes, formatCount, formatDuration } from "@/lib/format";

import { useBackupStatus } from "./use-monitoring";
import type { Json } from "./use-admin";

type Query = { data?: Json; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
type Fact = { label: string; value: ReactNode };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const count = (v: unknown) => (n(v) === null ? null : formatCount(n(v)));

function Facts({ facts }: { facts: Fact[] }) {
  const shown = facts.filter((f) => f.value !== null && f.value !== undefined && f.value !== "");
  return (
    <dl className="grid min-w-0 grid-cols-[fit-content(55%)_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
      {shown.map((f) => (
        <div key={f.label} className="contents">
          <dt className="min-w-0 break-words text-muted">{f.label}</dt>
          <dd className="min-w-0 break-words tabular-nums">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function FactCard({ title, query, facts }: { title: string; query: Query; facts: (d: Record<string, unknown>) => Fact[] }) {
  const { t } = useTranslation("admin");
  return (
    <SectionCard title={title} className="h-full">
      {query.isError ? (
        <QueryError error={query.error} onRetry={() => void query.refetch()} notFoundTitle={t("notAvailable")} />
      ) : query.isPending ? (
        <div aria-busy="true"><Skeleton className="h-16 w-full" /></div>
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          <Facts facts={facts(obj(query.data))} />
        </div>
      )}
    </SectionCard>
  );
}

export function NodeStatusCard({ query }: { query: Query }) {
  const { t } = useTranslation("operator");
  return (
    <FactCard
      title={t("node.statusTitle")}
      query={query}
      facts={(d) => {
        const host = obj(d.host);
        const disk = obj(host.disk);
        const load = Array.isArray(host.load) ? host.load.filter((v): v is number => typeof v === "number") : [];
        const mode = typeof d.mode === "string" ? d.mode : null;
        return [
          { label: t("node.version"), value: d.version as string },
          { label: t("node.mode"), value: mode ? t(`node.modes.${mode}`, { defaultValue: mode }) : null },
          { label: t("node.profile"), value: d.default_profile as string },
          { label: t("node.processors"), value: count(d.processors) },
          { label: t("node.cores"), value: count(host.cores) },
          { label: t("node.inflight"), value: count(d.inflight) },
          { label: t("node.services"), value: count(host.services) },
          { label: t("node.storage"), value: n(host.storage_bytes) !== null ? formatBytes(n(host.storage_bytes)) : null },
          { label: t("node.load"), value: load.length ? load.map((v) => v.toFixed(2)).join(" / ") : null },
          {
            label: t("node.disk"),
            value: n(disk.free_bytes) !== null ? t("node.diskValue", { free: formatBytes(n(disk.free_bytes)), total: formatBytes(n(disk.total_bytes)) }) : null,
          },
          { label: t("node.sandbox"), value: typeof d.v8_sandbox === "boolean" ? t(d.v8_sandbox ? "yes" : "no") : null },
        ];
      }}
    />
  );
}

export function NodeSchedulerCard({ query }: { query: Query }) {
  const { t } = useTranslation("operator");
  return (
    <FactCard
      title={t("node.schedulerTitle")}
      query={query}
      facts={(d) => {
        const adm = obj(d.admission);
        const grq = Object.values(obj(d.grq)).filter((v): v is number => typeof v === "number");
        return [
          { label: t("node.uptime"), value: n(d.uptime_ms) !== null ? formatDuration(n(d.uptime_ms)) : null },
          { label: t("node.inflight"), value: count(d.inflight) },
          { label: t("node.idle"), value: count(d.idle) },
          { label: t("node.queued"), value: count(adm.queued) },
          { label: t("node.queuedBytes"), value: n(adm.queued_bytes) !== null ? formatBytes(n(adm.queued_bytes)) : null },
          { label: t("node.maxInflight"), value: count(adm.max_inflight) },
          { label: t("node.maxQueued"), value: count(adm.max_queued) },
          { label: t("node.globalQueue"), value: grq.length ? formatCount(grq.reduce((a, b) => a + b, 0)) : null },
          { label: t("node.waitingRuntime"), value: count(d.waiting_runtime) },
          { label: t("node.waitingMemory"), value: count(d.waiting_memory) },
          { label: t("node.submitted"), value: count(d.tasks_submitted) },
          { label: t("node.completed"), value: count(d.tasks_completed) },
        ];
      }}
    />
  );
}

/** The warning a node with no backups shows. Silent while unknown: an older node reports nothing to judge by. */
export function BackupWarning() {
  const { t } = useTranslation("operator");
  const status = useBackupStatus();
  if (!status.data || status.data.enabled) return null;
  return (
    <div role="alert" className="flex flex-col gap-1 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm">
      <p className="font-medium text-danger-text">{t("backups.warningTitle")}</p>
      <p>{t("backups.warningBody")}</p>
      <p className="text-muted">{t("backups.alertHint")}</p>
      <p className="flex flex-wrap gap-3">
        <Link to="/admin/backups" className="font-medium hover:underline">{t("backups.setUp")}</Link>
        <Link to="/admin/alerts" className="font-medium hover:underline">{t("backups.addRule")}</Link>
      </p>
    </div>
  );
}

type Owner = { org: string; app: string; version: number };

function CacheKind({ kind, stats }: { kind: string; stats: Record<string, unknown> }) {
  const { t } = useTranslation("operator");
  const hits = n(stats.hits) ?? 0;
  const misses = n(stats.misses) ?? 0;
  const lookups = hits + misses;
  const entry = (entries: unknown, bytes: unknown) => t("cache.entryValue", { count: n(entries) ?? 0, size: formatBytes(n(bytes) ?? 0) });
  return (
    <SectionCard title={t(`cache.kind.${kind}`, { defaultValue: kind })} description={t("cache.summary")} className="h-full">
      <Facts
        facts={[
          { label: t("cache.memory"), value: entry(stats.t1_entries, stats.t1_bytes) },
          { label: t("cache.disk"), value: entry(stats.t2_entries, stats.t2_bytes) },
          { label: t("cache.hitRate"), value: lookups ? `${Math.round((hits / lookups) * 100)}%` : t("cache.hitRateNone") },
          { label: t("cache.loading"), value: count(stats.loads_inflight) },
          { label: t("cache.building"), value: count(stats.builds_inflight) },
        ]}
      />
    </SectionCard>
  );
}

export function CacheView({ query }: { query: Query }) {
  const { t } = useTranslation(["operator", "admin"]);
  if (query.isError) return <QueryError error={query.error} onRetry={() => void query.refetch()} notFoundTitle={t("admin:notAvailable")} />;
  if (query.isPending) return <div aria-busy="true"><Skeleton className="h-40 w-full" /></div>;
  const data = obj(query.data);
  const owners = obj(data.owners) as Record<string, Owner | undefined>;
  const top = Object.values(obj(data.top)).flatMap((v) => (Array.isArray(v) ? v.filter((d): d is string => typeof d === "string") : []));
  const kinds = ["deno", "wasm"].filter((k) => data[k] && typeof data[k] === "object");
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {kinds.length ? (
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          {kinds.map((k) => <CacheKind key={k} kind={k} stats={obj(data[k])} />)}
        </div>
      ) : null}
      <SectionCard title={t("cache.topTitle")} flush>
        {top.length === 0 ? (
          <p className="p-4 text-sm text-muted">{t("cache.topEmpty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table stack>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("cache.app")}</TableHead>
                  <TableHead>{t("cache.version")}</TableHead>
                  <TableHead>{t("cache.org")}</TableHead>
                  <TableHead>{t("cache.digest")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {top.map((d) => {
                  const o = owners[d];
                  return (
                    <TableRow key={d}>
                      <TableCell>{o ? o.app : <span className="text-muted">{t("cache.unnamed")}</span>}</TableCell>
                      <TableCell className="tabular-nums">{o ? o.version : <span className="text-muted">{t("cache.systemApp")}</span>}</TableCell>
                      <TableCell>{o ? o.org : <span className="text-muted">{t("cache.systemApp")}</span>}</TableCell>
                      <TableCell className="font-mono text-xs" title={d}>{d.replace(/^sha256:/, "").slice(0, 12)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
