import { useMutation } from "@tanstack/react-query";
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
import { api } from "@/lib/api";

// RotateDefaultKey replaces the org's default runtime key (owner/admin, defaultkey.rotate).
// Custom tokens keep working. Errors use the global mutation toast.
export function RotateDefaultKey({ org }: { org: string }) {
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
        toast.success("Default key rotated. Custom tokens keep working.");
      },
    });
  }

  return (
    <section aria-labelledby="default-key-title" className="flex max-w-xl flex-col gap-3 rounded-[10px] border border-line bg-surface p-4">
      <h2 id="default-key-title" className="text-base font-semibold">
        Default key
      </h2>
      <p className="text-sm text-muted">
        The console uses the org's default key to manage apps. Rotate it if it may have leaked. Custom tokens are not
        affected.
      </p>
      <div>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Rotate default key
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
            <DialogTitle>Rotate the default key of {org}?</DialogTitle>
            <DialogDescription>The old default key stops working. Type the org slug to confirm.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <Label htmlFor="confirm-rotate">Type {org} to confirm</Label>
            <Input id="confirm-rotate" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={!matches || rotate.isPending} onClick={onConfirm}>
              Rotate key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
