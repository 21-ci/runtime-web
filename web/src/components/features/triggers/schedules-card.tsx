import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { QueryError } from "@/components/features/empty/query-error";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { i18n } from "@/lib/i18n";
import { formatDateTime } from "@/lib/format";

import { ConfirmDialog } from "./confirm-dialog";
import { describeCron } from "./cron-preview";
import { describeTriggerError } from "./errors";
import {
  useCreateSchedule,
  useDeleteSchedule,
  useSchedules,
  useUpdateSchedule,
  type Schedule,
  type ScheduleBody,
} from "./hooks";

// scheduleLabel is the human-readable line for a schedule row. It reads the current language at
// call time, and SchedulesCard subscribes to language changes, so rows re-render with it.
function scheduleLabel(s: Schedule): string {
  if (s.kind === "cron" && s.cron) return describeCron(s.cron) ?? s.cron;
  if (s.every_seconds) return i18n.t("triggers:schedules.everySeconds", { seconds: s.every_seconds });
  return i18n.t(`triggers:kind.${s.kind}`);
}

// SchedulesCard lists schedules and adds, pauses, resumes and deletes them.
export function SchedulesCard({ org, app, cronAllowed = true }: { org: string; app: string; cronAllowed?: boolean }) {
  const { t } = useTranslation(["triggers", "common"]);
  const schedules = useSchedules(org, app);
  const update = useUpdateSchedule(org, app);
  const remove = useDeleteSchedule(org, app);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Schedule | null>(null);

  return (
    <section aria-labelledby="schedules-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="schedules-heading" className="text-[15px] font-semibold">
            {t("schedules.title")}
          </h2>
          <p className="text-sm text-muted">{t("schedules.description")}</p>
        </div>
        {schedules.isSuccess && schedules.data.length > 0 ? (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            {t("schedules.add")}
          </Button>
        ) : null}
      </div>

      {schedules.isError ? (
        <QueryError error={schedules.error} onRetry={() => void schedules.refetch()} notFoundTitle={t("schedules.notFound")} />
      ) : schedules.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : schedules.data.length === 0 ? (
        <EmptyState entity="triggers"
          title={t("schedules.emptyTitle")}
          description={t("schedules.emptyDescription")}
          action={<Button onClick={() => setAdding(true)}>{t("schedules.add")}</Button>}
        />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface shadow-card">
          {schedules.data.map((s) => {
            const label = scheduleLabel(s);
            return (
              <li key={s.id} className="group flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <div className="flex flex-col">
                  <span className="font-medium">{label}</span>
                  {s.cron ? <code className="text-xs text-muted">{s.cron}</code> : null}
                  {s.next_due ? (
                    <span className="text-xs text-muted">{t("schedules.next", { when: formatDateTime(s.next_due) })}</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      disabled={update.isPending}
                      onChange={(e) => update.mutate({ id: s.id, body: { enabled: e.target.checked } })}
                      aria-label={t("schedules.enabledFor", { label })}
                    />
                    {t("common:enabled")}
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                    aria-label={t("schedules.deleteFor", { label })}
                    onClick={() => setDeleting(s)}
                  >
                    {t("common:delete")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {adding ? <ScheduleDialog org={org} app={app} cronAllowed={cronAllowed} onClose={() => setAdding(false)} /> : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t("schedules.deleteTitle")}
        description={t("schedules.deleteDescription")}
        confirmLabel={t("schedules.deleteConfirm")}
        pending={remove.isPending}
        error={remove.isError ? <p role="alert" className="text-sm text-danger-text">{describeTriggerError(remove.error).message}</p> : null}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, {
            onSuccess: () => {
              setDeleting(null);
              toast.success(t("schedules.deleted"));
            },
          });
        }}
      />
    </section>
  );
}

// ScheduleDialog creates a schedule. The cron preview updates as the expression is typed.
function ScheduleDialog({
  org,
  app,
  cronAllowed,
  onClose,
}: {
  org: string;
  app: string;
  cronAllowed: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation(["triggers", "common"]);
  const create = useCreateSchedule(org, app);
  // Interval is the default; cron is the default only when the plan allows it.
  const [kind, setKind] = useState<"interval" | "cron">(cronAllowed ? "cron" : "interval");
  const [cron, setCron] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [every, setEvery] = useState("60");
  const [payloadText, setPayloadText] = useState("{}");
  const [formError, setFormError] = useState<string | null>(null);
  const [lastBody, setLastBody] = useState<ScheduleBody | null>(null);

  const preview =
    kind !== "cron" || cron.trim() === ""
      ? null
      : describeCron(cron) ?? t("schedules.dialog.cronPreviewFallback");

  function submit(body: ScheduleBody) {
    setLastBody(body);
    create.mutate(body, {
      onSuccess: () => {
        toast.success(t("schedules.created"));
        onClose();
      },
    });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    let payload: unknown;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      setFormError(t("schedules.dialog.errorPayload"));
      return;
    }
    if (kind === "cron") {
      if (cron.trim() === "") {
        setFormError(t("schedules.dialog.errorCronEmpty"));
        return;
      }
      submit({ kind, cron: cron.trim(), timezone: timezone.trim() || "UTC", payload, enabled: true });
    } else {
      const seconds = Number(every);
      if (!Number.isInteger(seconds) || seconds < 1) {
        setFormError(t("schedules.dialog.errorInterval"));
        return;
      }
      submit({ kind, every_seconds: seconds, payload, enabled: true });
    }
  }

  const err = create.isError ? describeTriggerError(create.error) : null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("schedules.add")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-kind">{t("schedules.dialog.kind")}</Label>
            {cronAllowed ? null : (
              <p id="schedule-kind-hint" className="text-sm text-muted">
                {t("schedules.dialog.cronNotInPlan")}
              </p>
            )}
            <Select value={kind} onValueChange={(v) => setKind(v as "interval" | "cron")}>
              <SelectTrigger id="schedule-kind" aria-describedby={cronAllowed ? undefined : "schedule-kind-hint"}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cron" disabled={!cronAllowed}>
                  {t("kind.cron")}
                </SelectItem>
                <SelectItem value="interval">{t("kind.interval")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {kind === "cron" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="schedule-cron">{t("schedules.dialog.cronExpression")}</Label>
                <Input
                  id="schedule-cron"
                  placeholder="0 9 * * 1-5"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  aria-describedby="schedule-preview"
                />
                <p id="schedule-preview" aria-live="polite" className="text-sm text-muted">
                  {preview ?? t("schedules.dialog.cronHint")}
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="schedule-tz">{t("schedules.dialog.timezone")}</Label>
                <Input id="schedule-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="schedule-every">{t("schedules.dialog.every")}</Label>
              <Input
                id="schedule-every"
                type="number"
                min={1}
                value={every}
                onChange={(e) => setEvery(e.target.value)}
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-payload">{t("schedules.dialog.payload")}</Label>
            <textarea
              id="schedule-payload"
              rows={3}
              value={payloadText}
              onChange={(e) => setPayloadText(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              className="rounded-sm border border-line-strong bg-surface p-2 font-mono text-sm text-text focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            />
          </div>

          {formError ? (
            <p role="alert" className="text-sm text-danger-text">
              {formError}
            </p>
          ) : null}
          {err ? (
            <p role="alert" className="text-sm text-danger-text">
              {err.message}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={create.isPending}>
              {t("common:cancel")}
            </Button>
            {err?.retry && lastBody ? (
              <Button type="button" variant="secondary" onClick={() => submit(lastBody)} disabled={create.isPending}>
                {t("common:retry")}
              </Button>
            ) : null}
            <Button type="submit" variant="default" disabled={create.isPending}>
              {create.isPending ? t("common:saving") : t("schedules.dialog.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
