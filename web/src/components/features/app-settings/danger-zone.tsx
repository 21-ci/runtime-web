import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type AppDetail, useDeleteApp } from "./api";

// DangerZone deletes the app. Deleting is irreversible, so the button stays disabled until the
// user types the app slug. The app's domains are removed with it.
export function DangerZone({
  org,
  app,
  onDeleted,
}: {
  org: string;
  app: AppDetail;
  onDeleted: () => void;
}) {
  const { t } = useTranslation(["app-settings", "common"]);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const del = useDeleteApp(org, app.slug);
  const matches = typed === app.slug;

  async function onConfirm() {
    if (!matches) return;
    try {
      await del.mutateAsync();
      setOpen(false);
      toast.success(t("danger.deleted", { name: app.name ?? app.slug }));
      onDeleted();
    } catch {
      toast.error(t("danger.failed"));
    }
  }

  return (
    <section
      aria-labelledby="danger-title"
      className="flex flex-col gap-3 rounded-lg border border-danger/30 bg-surface p-5 shadow-card sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <h2 id="danger-title" className="text-[15px] font-semibold text-text">
          {t("danger.title")}
        </h2>
        <p className="text-sm text-muted">{t("danger.description")}</p>
      </div>
      <div className="shrink-0">
        <Button variant="danger" onClick={() => setOpen(true)}>
          {t("danger.button")}
        </Button>
      </div>

      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) setTyped("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("danger.confirmTitle", { slug: app.slug })}</DialogTitle>
            <DialogDescription>{t("danger.confirmDescription")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <Label htmlFor="confirm-slug">
              <Trans
                i18nKey="danger.typeToConfirm"
                ns="app-settings"
                values={{ value: app.slug }}
                components={{ mono: <span className="font-mono" /> }}
              />
            </Label>
            <Input id="confirm-slug" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t("common:cancel")}
            </Button>
            <Button variant="danger-solid" disabled={!matches || del.isPending} onClick={onConfirm}>
              {t("danger.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
