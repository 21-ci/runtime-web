import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
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
import { api } from "@/lib/api";

// RotateDefaultKey replaces the org's default runtime key (owner/admin, defaultkey.rotate).
// Custom tokens keep working. Errors use the global mutation toast.
export function RotateDefaultKey({ org }: { org: string }) {
  const { t } = useTranslation(["org", "common"]);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const rotate = useMutation({
    mutationFn: () => api.post<void>(`/orgs/${encodeURIComponent(org)}/default-key/rotate`),
  });
  const matches = typed === org;

  function onConfirm() {
    if (!matches) return;
    rotate.mutate(undefined, {
      onSuccess: () => {
        setOpen(false);
        setTyped("");
        toast.success(t("rotate.toast"));
      },
    });
  }

  return (
    <section aria-labelledby="default-key-title" className="flex max-w-xl flex-col gap-3 rounded-lg border border-line bg-surface p-5 shadow-card">
      <h2 id="default-key-title" className="text-[15px] font-semibold">
        {t("rotate.title")}
      </h2>
      <p className="text-sm text-muted">{t("rotate.description")}</p>
      <div>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          {t("rotate.button")}
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
            <DialogTitle>{t("rotate.dialogTitle", { org })}</DialogTitle>
            <DialogDescription>{t("rotate.dialogDescription")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <Label htmlFor="confirm-rotate">{t("rotate.confirmLabel", { org })}</Label>
            <Input id="confirm-rotate" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t("common:cancel")}
            </Button>
            <Button variant="danger" disabled={!matches || rotate.isPending} onClick={onConfirm}>
              {t("rotate.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
