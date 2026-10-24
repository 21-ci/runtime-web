import { useState } from "react";
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
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const del = useDeleteApp(org, app.slug);
  const matches = typed === app.slug;

  async function onConfirm() {
    if (!matches) return;
    try {
      await del.mutateAsync();
      setOpen(false);
      toast.success(`Deleted ${app.name ?? app.slug}`);
      onDeleted();
    } catch {
      toast.error("Could not delete the app. Try again.");
    }
  }

  return (
    <section
      aria-labelledby="danger-title"
      className="flex flex-col gap-3 rounded-lg border border-danger/30 bg-surface p-5 shadow-card sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <h2 id="danger-title" className="text-[15px] font-semibold text-text">
          Delete this app
        </h2>
        <p className="text-sm text-muted">Deleting removes its code, data and domains. This cannot be undone.</p>
      </div>
      <div className="shrink-0">
        <Button variant="danger" onClick={() => setOpen(true)}>
          Delete app
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
            <DialogTitle>Delete {app.slug}?</DialogTitle>
            <DialogDescription>This is permanent. Type the app slug to confirm.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <Label htmlFor="confirm-slug">Type {app.slug} to confirm</Label>
            <Input id="confirm-slug" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger-solid" disabled={!matches || del.isPending} onClick={onConfirm}>
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
