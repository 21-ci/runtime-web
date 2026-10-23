import { createContext, useContext, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

import { ApiError } from "@/lib/api";

// fieldErrorsOf returns the 422 web validation map (request field path to message), or nothing.
export function fieldErrorsOf(err: unknown): Record<string, string> {
  if (err instanceof ApiError && err.status === 422) return err.fieldErrors();
  return {};
}

// Non-field server errors (e.g. a 422 for a field we do not render) are listed in the form alert.
export function unmappedErrors(fields: Record<string, string>, shown: string[]): string[] {
  return Object.entries(fields)
    .filter(([path]) => !shown.includes(path))
    .map(([path, msg]) => `${path}: ${msg}`);
}

// WriteAccess is false when the caller's role cannot change app settings (app.update): every
// section is then read-only and its Save button is not rendered.
export const WriteAccess = createContext(true);

export function SaveButton({ disabled, children }: { disabled?: boolean; children: ReactNode }) {
  if (!useContext(WriteAccess)) return null;
  return (
    <Button type="submit" disabled={disabled}>
      {children}
    </Button>
  );
}

export function Section({
  id,
  title,
  description,
  children,
  className = "",
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className={`flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-4 ${className}`}>
      <header className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-base font-semibold text-text">
          {title}
        </h2>
        {description ? <p className="text-sm text-muted">{description}</p> : null}
      </header>
      <fieldset disabled={!useContext(WriteAccess)} className="contents">
        {children}
      </fieldset>
    </section>
  );
}

export function FormAlert({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <div role="alert" className="rounded-[7px] border border-danger bg-danger-soft p-3 text-sm text-text">
      {messages.map((m) => (
        <p key={m}>{m}</p>
      ))}
    </div>
  );
}

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm text-danger-text">
      {message}
    </p>
  );
}

// replaceNote is shown under every form because the server replaces the whole block on save.
export const REPLACE_NOTE = "Saving replaces this whole block.";
