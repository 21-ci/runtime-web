import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { QueryError } from "@/components/features/empty/query-error";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";

import { ConfirmDialog } from "./confirm-dialog";
import { describeTriggerError } from "./errors";
import { useDlq, usePurgeDlq, useRedriveDlq } from "./hooks";

// DlqCard lists dead-lettered messages. Redrive and purge both sit behind confirmation; purge is
// irreversible, so it also needs the confirmation word typed in (translated per language).
export function DlqCard({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation(["triggers", "common"]);
  const dlq = useDlq(org, app);
  const redrive = useRedriveDlq(org, app);
  const purge = usePurgeDlq(org, app);
  const [redriveOpen, setRedriveOpen] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [typed, setTyped] = useState("");

  if (dlq.isError) {
    return <QueryError error={dlq.error} onRetry={() => void dlq.refetch()} notFoundTitle={t("dlq.notFound")} />;
  }
  if (dlq.isPending) return <Skeleton className="h-24 w-full" />;

  const items = dlq.data;
  const count = items.length;
  const purgeWord = t("dlq.purgeWord");
  const redriveErr = redrive.isError ? describeTriggerError(redrive.error) : null;
  const purgeErr = purge.isError ? describeTriggerError(purge.error) : null;

  return (
    <section aria-labelledby="dlq-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="dlq-heading" className="text-[15px] font-semibold">
            {t("dlq.title")}
          </h2>
          <p className="text-sm text-muted">{t("dlq.description")}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={count === 0} onClick={() => setRedriveOpen(true)}>
            {t("dlq.redrive")}
          </Button>
          <Button variant="danger" disabled={count === 0} onClick={() => setPurgeOpen(true)}>
            {t("dlq.purge")}
          </Button>
        </div>
      </div>

      {count === 0 ? (
        <EmptyState entity="triggers" title={t("dlq.empty")} description={t("dlq.emptyDescription")} />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface shadow-card">
          {items.map((m) => (
            <li key={m.id} className="flex min-w-0 flex-col gap-1 px-3 py-2 text-sm">
              <span className="break-all font-mono text-xs">{m.id}</span>
              <span className="text-xs text-muted">
                {t("dlq.attempts", { count: m.attempts, when: formatDateTime(m.failed_at) })}
              </span>
              <code className="truncate text-xs">{JSON.stringify(m.body)}</code>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={redriveOpen}
        onOpenChange={(open) => {
          setRedriveOpen(open);
          if (!open) redrive.reset();
        }}
        title={t("dlq.redriveTitle")}
        description={t("dlq.redriveDescription", { count })}
        confirmLabel={t("dlq.redrive")}
        destructive={false}
        pending={redrive.isPending}
        error={redriveErr ? <p role="alert" className="text-sm text-danger-text">{redriveErr.message}</p> : null}
        onRetry={redriveErr?.retry ? () => redrive.mutate(undefined) : undefined}
        onConfirm={() =>
          redrive.mutate(undefined, {
            onSuccess: (res) => {
              setRedriveOpen(false);
              toast.success(t("dlq.toast.redriven", { count: res.redriven }));
            },
          })
        }
      />

      <ConfirmDialog
        open={purgeOpen}
        onOpenChange={(open) => {
          setPurgeOpen(open);
          setTyped("");
          if (!open) purge.reset();
        }}
        title={t("dlq.purgeTitle")}
        description={t("dlq.purgeDescription")}
        confirmLabel={t("dlq.purgeConfirm")}
        confirmDisabled={typed !== purgeWord}
        pending={purge.isPending}
        error={purgeErr ? <p role="alert" className="text-sm text-danger-text">{purgeErr.message}</p> : null}
        onRetry={purgeErr?.retry ? () => purge.mutate(undefined) : undefined}
        onConfirm={() =>
          purge.mutate(undefined, {
            onSuccess: () => {
              setPurgeOpen(false);
              toast.success(t("dlq.toast.purged"));
            },
          })
        }
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="purge-confirm">{t("dlq.purgeTypeLabel", { word: purgeWord })}</Label>
          <Input
            id="purge-confirm"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
      </ConfirmDialog>
    </section>
  );
}
