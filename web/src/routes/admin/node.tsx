import { useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";

import { AdminLayout } from "@/components/features/admin/admin-layout";
import { requireInstanceAdmin } from "@/components/features/admin/gate";
import { KeyValueCard } from "@/components/features/admin/key-value-card";
import {
  useDrainNode,
  useNodeConfig,
  useNodeScheduler,
  useNodeStatus,
  useSaveNodeConfig,
  type NodeConfig,
} from "@/components/features/admin/use-admin";
import { QueryError } from "@/components/features/empty/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";

export const Route = createFileRoute("/admin/node")({
  beforeLoad: ({ context }) => requireInstanceAdmin(context.queryClient),
  component: AdminNodePageRoute,
});

function AdminNodePageRoute() {
  return (
    <AdminLayout>
      <AdminNodePage />
    </AdminLayout>
  );
}

function AdminNodePage() {
  const status = useNodeStatus();
  const scheduler = useNodeScheduler();
  const config = useNodeConfig();

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <h1 className="text-xl font-semibold">Node</h1>

      <div className="grid gap-4 md:grid-cols-2">
        <KeyValueCard title="Status" query={status} />
        <KeyValueCard title="Scheduler" query={scheduler} />
      </div>

      <section aria-labelledby="node-config-heading" className="rounded-[10px] border border-line bg-surface p-4">
        <h2 id="node-config-heading" className="mb-3 text-sm font-semibold">
          Configuration
        </h2>
        {config.isError ? (
          <QueryError error={config.error} onRetry={() => void config.refetch()} notFoundTitle="Not available" />
        ) : config.isPending ? (
          <div aria-busy="true">
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <NodeConfigForm initial={config.data} />
        )}
      </section>

      <DrainSection />
    </div>
  );
}

// NodeConfigForm edits the three runtime settings the console exposes. Other runtime keys are not
// shown and not sent.
function NodeConfigForm({ initial }: { initial: NodeConfig }) {
  const save = useSaveNodeConfig();
  const [degradation, setDegradation] = useState(initial.degradation_mode ?? "");
  const [profile, setProfile] = useState(initial.default_profile ?? "");
  const [rateLimit, setRateLimit] = useState(JSON.stringify(initial.rate_limit ?? {}, null, 2));
  const [errors, setErrors] = useState<Record<string, string>>({});

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(rateLimit);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not object");
      parsed = value as Record<string, unknown>;
    } catch {
      setErrors({ rate_limit: "Enter a JSON object, for example {}." });
      return;
    }
    setErrors({});
    save.mutate(
      { degradation_mode: degradation, default_profile: profile, rate_limit: parsed },
      {
        onSuccess: (res) => {
          if (res.pending_restart.length > 0) {
            toast.success(`Saved. Restart the node to apply: ${res.pending_restart.join(", ")}.`);
          } else {
            toast.success("Node configuration saved.");
          }
        },
        onError: (err) => {
          if (err instanceof ApiError && Object.keys(err.fieldErrors()).length > 0) {
            setErrors(err.fieldErrors());
          } else {
            toast.error("Could not save the node configuration. Try again.");
          }
        },
      },
    );
  }

  return (
    <form aria-label="Node configuration" onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="degradation_mode">Degradation mode</Label>
        <Input
          id="degradation_mode"
          name="degradation_mode"
          value={degradation}
          onChange={(e) => setDegradation(e.target.value)}
          aria-invalid={errors.degradation_mode ? true : undefined}
        />
        {errors.degradation_mode ? <p className="text-sm text-danger">{errors.degradation_mode}</p> : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="default_profile">Default profile</Label>
        <Input
          id="default_profile"
          name="default_profile"
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
          aria-invalid={errors.default_profile ? true : undefined}
        />
        {errors.default_profile ? <p className="text-sm text-danger">{errors.default_profile}</p> : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Label htmlFor="rate_limit">Rate limit (JSON)</Label>
          <Badge variant="outline">applies after restart</Badge>
        </div>
        <textarea
          id="rate_limit"
          name="rate_limit"
          rows={5}
          spellCheck={false}
          value={rateLimit}
          onChange={(e) => setRateLimit(e.target.value)}
          aria-invalid={errors.rate_limit ? true : undefined}
          className="rounded-[8px] border border-line-strong bg-surface p-2 font-mono text-sm"
        />
        {errors.rate_limit ? <p className="text-sm text-danger">{errors.rate_limit}</p> : null}
      </div>

      <div>
        <Button type="submit" disabled={save.isPending}>
          Save configuration
        </Button>
      </div>
    </form>
  );
}

// DrainSection stops the node from taking new work. It is irreversible from this page, so the
// confirm button stays disabled until "drain" is typed.
function DrainSection() {
  const drain = useDrainNode();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setTyped("");
  }

  function onDrain() {
    drain.mutate(undefined, {
      onSuccess: () => {
        toast.success("Drain started.");
        onOpenChange(false);
      },
      onError: () => toast.error("Could not start the drain. Try again."),
    });
  }

  return (
    <section aria-labelledby="drain-heading" className="rounded-[10px] border border-line bg-surface p-4">
      <h2 id="drain-heading" className="mb-1 text-sm font-semibold">
        Drain
      </h2>
      <p className="mb-3 text-sm text-muted">Stop the node from accepting new work. Existing work finishes first.</p>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogTrigger asChild>
          <Button variant="danger">Drain node</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Drain this node?</DialogTitle>
          <DialogDescription>New work stops being accepted. Type drain to confirm.</DialogDescription>
          <div className="mt-4 flex flex-col gap-1.5">
            <Label htmlFor="drain-confirm">Type drain to confirm</Label>
            <Input id="drain-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={typed !== "drain" || drain.isPending} onClick={onDrain}>
              Drain node
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
