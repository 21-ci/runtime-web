import { useEffect, useId, useRef, type FormEvent, type ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// AuthForm wraps a <form> and moves focus to the first invalid field whenever errors change.
function AuthForm({
  errors,
  onSubmit,
  children,
}: {
  errors: Record<string, string>;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const key = Object.keys(errors).join("|");

  useEffect(() => {
    if (key) ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [key, errors]);

  return (
    <form ref={ref} noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      {children}
    </form>
  );
}

// FormField renders a label, optional hint and input, and an inline error. The input is wired
// with aria-invalid and aria-describedby (hint and error ids).
function FormField({
  label,
  name,
  error,
  hint,
  ...input
}: { label: string; name: string; error?: string; hint?: string } & React.ComponentProps<"input">) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {hint ? (
        <p id={hintId} className="-mt-1 text-sm text-muted">
          {hint}
        </p>
      ) : null}
      <Input
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...input}
      />
      {error ? (
        <p id={errorId} className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export { AuthForm, FormField };
