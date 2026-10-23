import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// ConfirmDialog is the alert dialog used for destructive trigger actions. It keeps focus inside,
// and the confirm button stays disabled while confirmDisabled is set (typed confirmation).
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  destructive = true,
  pending = false,
  confirmDisabled = false,
  error,
  onRetry,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  destructive?: boolean;
  pending?: boolean;
  confirmDisabled?: boolean;
  error?: ReactNode;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent role="alertdialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        {error}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          {onRetry && error ? (
            <Button variant="secondary" onClick={onRetry} disabled={pending}>
              Retry
            </Button>
          ) : null}
          <Button variant={destructive ? "danger" : "default"} onClick={onConfirm} disabled={pending || confirmDisabled}>
            {pending ? "Working..." : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
