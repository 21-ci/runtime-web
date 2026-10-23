import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { QueryError } from "@/components/features/empty/query-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

import { describeTriggerError } from "./errors";
import { useEnqueue, useQueueStats, type EnqueueBody } from "./hooks";

// QueueCard shows queue depth and sends a test message. A busy runtime or rate limit keeps the
// message in the form and offers a retry with the same payload.
export function QueueCard({ org, app }: { org: string; app: string }) {
  const stats = useQueueStats(org, app);
  const enqueue = useEnqueue(org, app);
  const [bodyText, setBodyText] = useState('{"hello": "world"}');
  const [delay, setDelay] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [pending, setPending] = useState<EnqueueBody | null>(null);

  if (stats.isError) {
    return <QueryError error={stats.error} onRetry={() => void stats.refetch()} notFoundTitle="Queue not found" />;
  }

  function send(body: EnqueueBody) {
    setPending(body);
    enqueue.mutate(body, {
      onSuccess: () => {
        setPending(null);
        toast.success("Test message enqueued");
      },
    });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      setParseError("Message body must be valid JSON.");
      return;
    }
    setParseError(null);
    const seconds = delay.trim() === "" ? undefined : Number(delay);
    send({ body: parsed, ...(seconds !== undefined ? { delay_seconds: seconds } : {}) });
  }

  const err = enqueue.isError ? describeTriggerError(enqueue.error) : null;

  return (
    <section aria-labelledby="queue-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="queue-heading" className="text-base font-semibold">
          Queue
        </h2>
        <p className="text-sm text-muted">Send a test message to check the handler.</p>
      </div>

      {stats.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-[6px] border border-line bg-surface p-3">
            <dt className="text-xs text-muted">Depth</dt>
            <dd className="font-semibold">{stats.data.depth}</dd>
          </div>
          <div className="rounded-[6px] border border-line bg-surface p-3">
            <dt className="text-xs text-muted">In flight</dt>
            <dd className="font-semibold">{stats.data.in_flight}</dd>
          </div>
          <div className="rounded-[6px] border border-line bg-surface p-3">
            <dt className="text-xs text-muted">Oldest</dt>
            <dd className="font-semibold">{Math.round(stats.data.oldest_age_ms / 1000)} s</dd>
          </div>
          <div className="rounded-[6px] border border-line bg-surface p-3">
            <dt className="text-xs text-muted">Dead-lettered</dt>
            <dd className="font-semibold">{stats.data.dlq}</dd>
          </div>
        </dl>
      )}

      <form onSubmit={onSubmit} className="flex max-w-xl flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="queue-body">Message body (JSON)</Label>
          <textarea
            id="queue-body"
            rows={4}
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            className="rounded-[4px] border border-line-strong bg-surface p-2 font-mono text-sm text-text focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="queue-delay">Delay in seconds (optional)</Label>
          <Input
            id="queue-delay"
            type="number"
            min={0}
            value={delay}
            onChange={(e) => setDelay(e.target.value)}
          />
        </div>
        {parseError ? (
          <p role="alert" className="text-sm text-danger-text">
            {parseError}
          </p>
        ) : null}
        {err ? (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-danger-text">
              {err.message}
            </p>
            {err.retry && pending ? (
              <Button type="button" variant="secondary" size="sm" onClick={() => send(pending)}>
                Retry
              </Button>
            ) : null}
          </div>
        ) : null}
        <Button type="submit" variant="default" className="self-start" disabled={enqueue.isPending}>
          {enqueue.isPending ? "Sending…" : "Enqueue test message"}
        </Button>
      </form>
    </section>
  );
}
