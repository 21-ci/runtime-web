import { useId, useState, type ReactNode } from "react";

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

// ConfirmDialog gates a destructive or security-sensitive action. When `typedValue` is set (the
// irreversible case), the user must type that exact value before the confirm button enables.
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending = false,
  error,
  typedValue,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  error?: string;
  typedValue?: string;
}) {
  const [typed, setTyped] = useState("");
  const typeId = useId();
  const needsTyping = typedValue !== undefined;
  const ready = !needsTyping || typed === typedValue;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped("");
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-col gap-2">{description}</div>
          </DialogDescription>
        </DialogHeader>
        {needsTyping ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={typeId}>
              Type <span className="font-mono">{typedValue}</span> to confirm
            </Label>
            <Input
              id={typeId}
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!ready || pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
