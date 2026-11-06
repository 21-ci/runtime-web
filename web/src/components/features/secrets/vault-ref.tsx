import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { FormField } from "@/components/auth/auth-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { formatDate } from "@/lib/format";

import { useLinkSecret, useSyncSecrets, useUnlinkSecret, type SecretMeta } from "./hooks";

// A Vault reference holds a path and a field; the node resolves the value and the console never sees it.
export function VaultStatus({ secret }: { secret: SecretMeta }) {
  const { t } = useTranslation("plans");
  if (secret.source !== "vault") return null;
  const hint = secret.last_error
    ? t("vault.errorPrefix", { error: secret.last_error })
    : secret.last_synced_at
      ? t("vault.synced", { when: formatDate(secret.last_synced_at) })
      : t("vault.neverSynced");
  return (
    <Badge variant={secret.last_error ? "warning" : "outline"} title={hint}>
      {t("vault.badge")}
      <span className="sr-only">: {hint}</span>
    </Badge>
  );
}

export function UnlinkButton({ org, app, name }: { org: string; app: string; name: string }) {
  const { t } = useTranslation("plans");
  const unlink = useUnlinkSecret(org, app);
  return (
    <Button
      variant="ghost"
      aria-label={t("vault.unlinkLabel", { name })}
      disabled={unlink.isPending}
      onClick={() => unlink.mutate(name, { onSuccess: () => toast.success(t("vault.unlinked", { name })) })}
    >
      {t("vault.unlink")}
    </Button>
  );
}

export function VaultActions({ org, app, hasRefs }: { org: string; app: string; hasRefs: boolean }) {
  const { t } = useTranslation(["plans", "common"]);
  const link = useLinkSecret(org, app);
  const sync = useSyncSecrets(org, app);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const [name, path, field] = ["ref_name", "path", "field"].map((k) => String(data.get(k) ?? "").trim()) as [string, string, string];
    if (!name || !path || !field) {
      setError(t("vault.required"));
      return;
    }
    setError(null);
    link.mutate(
      { name, path, field },
      {
        onSuccess: () => {
          setOpen(false);
          toast.success(t("vault.linked", { name }));
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === "ref_outside_prefix") setError(t("vault.outsidePrefix"));
        },
      },
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t("vault.link")}
      </Button>
      {hasRefs ? (
        <Button
          variant="secondary"
          disabled={sync.isPending}
          onClick={() => sync.mutate(undefined, { onSuccess: () => toast.success(t("vault.syncStarted")) })}
        >
          {t("vault.sync")}
        </Button>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("vault.linkTitle")}</DialogTitle>
            <DialogDescription>{t("vault.linkDescription")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <FormField label={t("common:name")} name="ref_name" autoComplete="off" />
            <FormField label={t("vault.path")} name="path" autoComplete="off" />
            <FormField label={t("vault.field")} name="field" autoComplete="off" />
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="submit" disabled={link.isPending}>
                {t("vault.submit")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
