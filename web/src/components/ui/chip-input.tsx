import { X } from "lucide-react";
import { useId, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

import { INPUT } from "./input";

export interface ChipInputProps {
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Returns the message for a value that cannot be added, or null. */
  validate?: (value: string) => string | null;
  max?: number;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
}

// ChipInput is the list-of-values field (guidelines rule 7): one chip per value, Enter or comma adds, Backspace removes,
// a paste splits on whitespace and commas. A value that fails validate stays in the box.
export function ChipInput({ id, value, onChange, placeholder, validate, max, disabled = false, invalid, describedBy, className }: ChipInputProps) {
  const { t } = useTranslation("common");
  const errorId = useId();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const full = max !== undefined && value.length >= max;

  /** Adds what it can and returns the first part it could not, with why. */
  function add(parts: string[]): { rejected: string; message: string } | null {
    const next = [...value];
    let failed: { rejected: string; message: string } | null = null;
    for (const raw of parts) {
      const part = raw.trim();
      if (part === "" || next.includes(part)) continue;
      if (max !== undefined && next.length >= max) break;
      const message = validate?.(part) ?? null;
      if (message !== null) {
        failed ??= { rejected: part, message };
        continue;
      }
      next.push(part);
    }
    if (next.length !== value.length) onChange(next);
    return failed;
  }

  function commit(parts: string[]) {
    const failed = add(parts);
    setDraft(failed?.rejected ?? "");
    setError(failed?.message ?? null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit([draft]);
    } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    if (!/[\s,]/.test(text.trim())) return;
    e.preventDefault();
    commit(text.split(/[\s,]+/));
  }

  const showInvalid = invalid === true || error !== null;
  const described = [describedBy, error !== null ? errorId : undefined].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div
        className={cn(
          INPUT,
          "h-auto min-h-9 flex-wrap items-center gap-1.5 px-2 py-1.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-focus",
          showInvalid && "border-danger",
          disabled && "opacity-60",
          className,
        )}
      >
        {value.map((chip) => (
          <span key={chip} className="inline-flex max-w-full items-center gap-1 rounded-sm bg-surface-2 py-0.5 ps-2 pe-0.5 font-mono text-[13px] text-text">
            <span className="truncate" title={chip}>
              {chip}
            </span>
            {disabled ? null : (
              <button
                type="button"
                aria-label={t("removeChip", { value: chip })}
                onClick={() => onChange(value.filter((v) => v !== chip))}
                className="grid size-5 cursor-pointer place-items-center rounded-sm text-muted hover:bg-line hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            )}
          </span>
        ))}
        <input
          id={id}
          value={draft}
          disabled={disabled || full}
          placeholder={value.length === 0 ? placeholder : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => {
            if (draft.trim() !== "") commit([draft]);
          }}
          aria-invalid={showInvalid ? true : undefined}
          aria-describedby={described}
          autoComplete="off"
          spellCheck={false}
          className="min-w-24 flex-1 bg-transparent py-1 font-mono text-[13px] outline-none placeholder:text-muted disabled:cursor-not-allowed"
        />
      </div>
      {error !== null ? (
        <p id={errorId} role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
