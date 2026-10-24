import { useId, useRef, useState, type ReactNode } from "react";

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

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  /** Specific action label, e.g. "Delete app". Never a bare "Confirm". */
  confirmLabel: string;
  onConfirm: () => void;
  /** Destructive styling for the confirm button. Defaults to true. */
  destructive?: boolean;
  pending?: boolean;
  /** Externally controlled gate, for callers that own the typed value. */
  confirmDisabled?: boolean;
  /** A string is rendered as an alert. A node is rendered as given. */
  error?: ReactNode;
  onRetry?: () => void;
  /** When set, the user must type this exact value before confirming. Internal state, reset on close. */
  typedValue?: string;
  children?: ReactNode;
}

// ConfirmDialog gates destructive or security-sensitive actions. Focus opens on Cancel, so an
// accidental Enter cannot confirm. The typed confirmation is either internal (`typedValue`) or
// owned by the caller (`confirmDisabled` plus children).
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
  typedValue,
  children,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const typeId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
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
      <DialogContent
        role="alertdialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
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
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </div>
        ) : null}
        {children}
        {typeof error === "string" ? (
          <p role="alert" className="text-[13px] text-danger-text">
            {error}
          </p>
        ) : (
          error
        )}
        <DialogFooter>
          <Button ref={cancelRef} variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          {onRetry && error ? (
            <Button variant="secondary" onClick={onRetry} disabled={pending}>
              Retry
            </Button>
          ) : null}
          <Button
            variant={destructive ? "danger" : "default"}
            onClick={onConfirm}
            disabled={pending || confirmDisabled || !ready}
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
