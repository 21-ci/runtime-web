import { useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { KeyValueCard, KeyValueTables } from "@/components/features/admin/key-value-card";
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
import { PageHeader } from "@/components/ui/page-header";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";

export const Route = createFileRoute("/admin/node")({
  component: AdminNodePage,
});

// AdminNodePage: Status and Scheduler summaries side by side at equal height, the scheduler's
// process and machine lists as full-width tables, then configuration and drain.
function AdminNodePage() {
  const { t } = useTranslation(["admin", "common"]);
  const status = useNodeStatus();
  const scheduler = useNodeScheduler();
  const config = useNodeConfig();

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader icon={Server} entity="admin" title={t("node.title")} description={t("node.description")} />

      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <KeyValueCard title={t("node.status")} description={t("node.statusDescription")} query={status} tables="omit" />
        <KeyValueCard title={t("node.scheduler")} description={t("node.schedulerDescription")} query={scheduler} tables="omit" />
      </div>
      <KeyValueTables query={status} source={t("node.status")} />
      <KeyValueTables query={scheduler} source={t("node.scheduler")} />

      <SectionCard title={t("node.configTitle")} description={t("node.configDescription")}>
        {config.isError ? (
          <QueryError error={config.error} onRetry={() => void config.refetch()} notFoundTitle={t("notAvailable")} />
        ) : config.isPending ? (
          <div aria-busy="true">
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <NodeConfigForm initial={config.data} />
        )}
      </SectionCard>

      <DrainSection />
    </div>
  );
}

// NodeConfigForm edits the three runtime settings the console exposes. Other runtime keys are not
// shown and not sent.
function NodeConfigForm({ initial }: { initial: NodeConfig }) {
  const { t } = useTranslation(["admin", "common"]);
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
      setErrors({ rate_limit: t("node.rateLimitInvalid") });
      return;
    }
    setErrors({});
    save.mutate(
      { degradation_mode: degradation, default_profile: profile, rate_limit: parsed },
      {
        onSuccess: (res) => {
          if (res.pending_restart.length > 0) {
            toast.success(t("node.saved", { keys: res.pending_restart.join(", ") }));
          } else {
            toast.success(t("node.savedNoRestart"));
          }
        },
        onError: (err) => {
          if (err instanceof ApiError && Object.keys(err.fieldErrors()).length > 0) {
            setErrors(err.fieldErrors());
          } else {
            toast.error(t("node.saveFailed"));
          }
        },
      },
    );
  }

  return (
    <form aria-label={t("node.formLabel")} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="degradation_mode">{t("node.degradation")}</Label>
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
        <Label htmlFor="default_profile">{t("node.profile")}</Label>
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
          <Label htmlFor="rate_limit">{t("node.rateLimit")}</Label>
          <Badge variant="outline">{t("node.restartBadge")}</Badge>
        </div>
        <textarea
          id="rate_limit"
          name="rate_limit"
          rows={5}
          spellCheck={false}
          value={rateLimit}
          onChange={(e) => setRateLimit(e.target.value)}
          aria-invalid={errors.rate_limit ? true : undefined}
          className="rounded-md border border-line-strong bg-field p-2 font-mono text-[13px] shadow-card outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus"
        />
        {errors.rate_limit ? <p className="text-sm text-danger">{errors.rate_limit}</p> : null}
      </div>

      <div>
        <Button type="submit" variant="default" disabled={save.isPending}>
          {t("node.save")}
        </Button>
      </div>
    </form>
  );
}

// DrainSection stops the node from taking new work. It is irreversible from this page, so the
// confirm button stays disabled until "drain" is typed.
function DrainSection() {
  const { t } = useTranslation(["admin", "common"]);
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
        toast.success(t("node.drainStarted"));
        onOpenChange(false);
      },
      onError: () => toast.error(t("node.drainFailed")),
    });
  }

  return (
    <SectionCard title={t("node.drainTitle")} description={t("node.drainDescription")}>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogTrigger asChild>
          <Button variant="danger">{t("node.drainButton")}</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>{t("node.drainDialogTitle")}</DialogTitle>
          <DialogDescription>{t("node.drainDialogDescription")}</DialogDescription>
          <div className="mt-4 flex flex-col gap-1.5">
            <Label htmlFor="drain-confirm">{t("node.drainConfirmLabel")}</Label>
            <Input id="drain-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {t("common:cancel")}
            </Button>
            <Button variant="danger" disabled={typed !== "drain" || drain.isPending} onClick={onDrain}>
              {t("node.drainButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
