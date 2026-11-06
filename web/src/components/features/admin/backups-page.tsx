import { Archive } from "lucide-react";
import { useTranslation } from "react-i18next";

import { QueryError } from "@/components/features/empty/query-error";
import { Badge } from "@/components/ui/badge";
import { Bounded } from "@/components/ui/bounded";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBytes } from "@/lib/chart";
import { formatDateTime } from "@/lib/format";

import { useBackups, useBackupStatus, useCreateBackup } from "./use-monitoring";

const FRAGMENT = `[backup]
enabled = true
schedule = "0 3 * * *"
keep_last = 3`;

const RESTORE = `rt backup verify <archive>
rt backup restore <archive> --data-dir <empty directory>`;

// BackupsPage: what the node reports about its backups, and a button to start one. There is deliberately no
// download or delete: the console's binding cannot reach them, because an archive holds every tenant's data.
export function BackupsPage() {
  const { t } = useTranslation(["monitoring", "operator", "common"]);
  const status = useBackupStatus();
  const list = useBackups();
  const create = useCreateBackup();
  const s = status.data;
  const running = Boolean(s?.running_id);
  const when = (ts: number | null | undefined) => (ts ? formatDateTime(ts) : t("backups.never"));
  const disabledWhy = status.isError ? t("operator:backups.whyUnknown") : s && !s.enabled ? t("operator:backups.whyOff") : running ? t("operator:backups.whyRunning") : null;
  const on = Boolean(s?.enabled);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader icon={Archive} entity="admin" title={t("backups.title")} description={t("backups.description")} />

      <SectionCard
        title={t("backups.status")}
        actions={
          <Button size="sm" disabled={!s?.enabled || running || create.isPending} title={disabledWhy ?? undefined} aria-describedby={disabledWhy ? "backup-why" : undefined} onClick={() => create.mutate()}>
            {running ? t("backups.running") : t("backups.now")}
          </Button>
        }
      >
        {disabledWhy ? <p id="backup-why" className="mb-3 text-sm text-muted">{disabledWhy}</p> : null}
        {status.isError ? (
          <QueryError error={status.error} onRetry={() => void status.refetch()} notFoundTitle={t("node.unavailable")} />
        ) : !s ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted">{t("backups.status")}</dt>
              <dd>{s.enabled ? t("backups.enabled") : t("backups.disabled")}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t("backups.schedule")}</dt>
              <dd className="font-mono">{s.schedule}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t("backups.lastOk")}</dt>
              <dd>{when(s.last_ok_at)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t("backups.next")}</dt>
              <dd>{when(s.next_at)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t("backups.destination")}</dt>
              <dd className="break-all">{[s.destination?.kind, s.destination?.endpoint_host, s.destination?.bucket].filter(Boolean).join(" ")}</dd>
            </div>
            {s.last_failure ? (
              <p role="alert" className="text-danger-text sm:col-span-2">
                {t("backups.failure", { code: s.last_failure.code ?? "" })}
              </p>
            ) : null}
          </dl>
        )}
      </SectionCard>

      <SectionCard title={t("backups.list")} flush>
        {(list.data?.items.length ?? 0) === 0 ? (
          <p className="p-4 text-sm text-muted">{t("backups.empty")}</p>
        ) : (
          <Bounded>
            <Table stack>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("backups.id")}</TableHead>
                  <TableHead>{t("backups.state")}</TableHead>
                  <TableHead>{t("backups.started_at")}</TableHead>
                  <TableHead className="text-right">{t("backups.size")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data?.items.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="font-mono text-xs">{b.id}</TableCell>
                    <TableCell>
                      <span className="flex flex-wrap items-center gap-2">
                        {b.state}
                        {b.failure ? ` (${b.failure.code})` : ""}
                        {!b.encrypted && b.state === "ok" ? <Badge variant="warning">{t("backups.plain")}</Badge> : null}
                      </span>
                    </TableCell>
                    <TableCell>{formatDateTime(b.started_at)}</TableCell>
                    <TableCell className="text-right tabular-nums">{b.bytes !== null ? formatBytes(b.bytes) : t("common:na")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Bounded>
        )}
      </SectionCard>

      <SectionCard title={t("backups.download")} description={t("operator:backups.downloadHint")}>
        <pre className="overflow-x-auto rounded bg-panel-2 p-3 font-mono text-xs">21ci backup download {list.data?.items[0]?.id ?? "<id>"}</pre>
      </SectionCard>

      <SectionCard title={t("operator:backups.restoreTitle")} description={t("operator:backups.restoreHint")}>
        <pre className="overflow-x-auto rounded bg-panel-2 p-3 font-mono text-xs">{RESTORE}</pre>
        <p className="mt-2 text-sm text-muted">{t("operator:backups.restoreEncrypted")}</p>
      </SectionCard>

      <SectionCard
        title={t(on ? "operator:backups.toChange" : "operator:backups.toEnable")}
        description={t(on ? "operator:backups.toChangeHint" : "operator:backups.toEnableHint")}
      >
        <pre className="overflow-x-auto rounded bg-panel-2 p-3 font-mono text-xs">{FRAGMENT}</pre>
      </SectionCard>
    </div>
  );
}
