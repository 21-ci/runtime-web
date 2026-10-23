import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { QueryError } from "@/components/features/empty/query-error";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

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

// scheduleLabel is the human-readable line for a schedule row.
function scheduleLabel(s: Schedule): string {
  if (s.kind === "cron" && s.cron) return describeCron(s.cron) ?? s.cron;
  if (s.every_seconds) return `Every ${s.every_seconds} s`;
  return s.kind;
}

// SchedulesCard lists schedules and adds, pauses, resumes and deletes them.
export function SchedulesCard({ org, app }: { org: string; app: string }) {
  const schedules = useSchedules(org, app);
  const update = useUpdateSchedule(org, app);
  const remove = useDeleteSchedule(org, app);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Schedule | null>(null);

  return (
    <section aria-labelledby="schedules-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="schedules-heading" className="text-base font-semibold">
            Schedules
          </h2>
          <p className="text-sm text-muted">Run the app on a fixed interval or cron expression.</p>
        </div>
        {schedules.isSuccess && schedules.data.length > 0 ? (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add schedule
          </Button>
        ) : null}
      </div>

      {schedules.isError ? (
        <QueryError error={schedules.error} onRetry={() => void schedules.refetch()} notFoundTitle="Schedules not found" />
      ) : schedules.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : schedules.data.length === 0 ? (
        <EmptyState
          title="No schedules yet"
          description="Add one to run this app on a timer."
          action={<Button onClick={() => setAdding(true)}>Add schedule</Button>}
        />
      ) : (
        <ul className="divide-y divide-line rounded-[6px] border border-line bg-surface">
          {schedules.data.map((s) => {
            const label = scheduleLabel(s);
            return (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <div className="flex flex-col">
                  <span className="font-medium">{label}</span>
                  {s.cron ? <code className="text-xs text-muted">{s.cron}</code> : null}
                  {s.next_due ? (
                    <span className="text-xs text-muted">Next {new Date(s.next_due).toLocaleString()}</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      disabled={update.isPending}
                      onChange={(e) => update.mutate({ id: s.id, body: { enabled: e.target.checked } })}
                      aria-label={`Enabled: ${label}`}
                    />
                    Enabled
                  </label>
                  <Button variant="ghost" size="sm" aria-label={`Delete schedule ${label}`} onClick={() => setDeleting(s)}>
                    Delete
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {adding ? <ScheduleDialog org={org} app={app} onClose={() => setAdding(false)} /> : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this schedule?"
        description="The schedule stops running. Its next run is cancelled."
        confirmLabel="Delete schedule"
        pending={remove.isPending}
        error={remove.isError ? <p role="alert" className="text-sm text-danger-text">{describeTriggerError(remove.error).message}</p> : null}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, {
            onSuccess: () => {
              setDeleting(null);
              toast.success("Schedule deleted");
            },
          });
        }}
      />
    </section>
  );
}

// ScheduleDialog creates a schedule. The cron preview updates as the expression is typed.
function ScheduleDialog({ org, app, onClose }: { org: string; app: string; onClose: () => void }) {
  const create = useCreateSchedule(org, app);
  const [kind, setKind] = useState<"interval" | "cron">("cron");
  const [cron, setCron] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [every, setEvery] = useState("60");
  const [payloadText, setPayloadText] = useState("{}");
  const [formError, setFormError] = useState<string | null>(null);
  const [lastBody, setLastBody] = useState<ScheduleBody | null>(null);

  const preview =
    kind !== "cron" || cron.trim() === ""
      ? null
      : describeCron(cron) ?? "Preview not available for this expression. Check the five fields.";

  function submit(body: ScheduleBody) {
    setLastBody(body);
    create.mutate(body, {
      onSuccess: () => {
        toast.success("Schedule created");
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
      setFormError("Payload must be valid JSON.");
      return;
    }
    if (kind === "cron") {
      if (cron.trim() === "") {
        setFormError("Enter a cron expression.");
        return;
      }
      submit({ kind, cron: cron.trim(), timezone: timezone.trim() || "UTC", payload, enabled: true });
    } else {
      const seconds = Number(every);
      if (!Number.isInteger(seconds) || seconds < 1) {
        setFormError("Interval must be a whole number of seconds, at least 1.");
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
          <DialogTitle>Add schedule</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-kind">Kind</Label>
            <select
              id="schedule-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as "interval" | "cron")}
              className="h-[34px] rounded-[4px] border border-line-strong bg-surface px-3 text-text"
            >
              <option value="cron">Cron</option>
              <option value="interval">Interval</option>
            </select>
          </div>

          {kind === "cron" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="schedule-cron">Cron expression</Label>
                <Input
                  id="schedule-cron"
                  placeholder="0 9 * * 1-5"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  aria-describedby="schedule-preview"
                />
                <p id="schedule-preview" aria-live="polite" className="text-sm text-muted">
                  {preview ?? "Minute, hour, day of month, month, day of week."}
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="schedule-tz">Timezone</Label>
                <Input id="schedule-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="schedule-every">Every (seconds)</Label>
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
            <Label htmlFor="schedule-payload">Payload (JSON)</Label>
            <textarea
              id="schedule-payload"
              rows={3}
              value={payloadText}
              onChange={(e) => setPayloadText(e.target.value)}
              className="rounded-[4px] border border-line-strong bg-surface p-2 font-mono text-sm text-text focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
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
              Cancel
            </Button>
            {err?.retry && lastBody ? (
              <Button type="button" variant="secondary" onClick={() => submit(lastBody)} disabled={create.isPending}>
                Retry
              </Button>
            ) : null}
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Saving..." : "Create schedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
