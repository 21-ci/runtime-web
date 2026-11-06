import { useRef, type KeyboardEvent } from "react";

import { cn } from "@/lib/utils";

export interface SegmentedOption<V extends string> {
  value: V;
  label: string;
}

// Segmented is the short single choice for ranges (guidelines rule 3): 1 h / 24 h / 7 d. It stays on one line and
// scrolls under md rather than wrapping.
export function Segmented<V extends string>({
  label,
  value,
  onChange,
  options,
  className,
}: {
  /** Accessible name of the group. */
  label: string;
  value: V;
  onChange: (next: V) => void;
  options: readonly SegmentedOption<V>[];
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const current = options.findIndex((o) => o.value === value);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (step === 0 || options.length === 0) return;
    e.preventDefault();
    // From the focused radio, not the value: a controlled parent may not have re-rendered between two presses.
    const radios = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    const from = radios.indexOf(document.activeElement as HTMLButtonElement);
    const next = ((from < 0 ? current : from) + step + options.length) % options.length;
    radios[next]?.focus();
    const option = options[next];
    if (option) onChange(option.value);
  }

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("inline-flex max-w-full gap-0.5 overflow-x-auto rounded-md border border-line bg-surface-2 p-0.5", className)}
    >
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (current < 0 && i === 0) ? 0 : -1}
            onClick={() => {
              if (!checked) onChange(o.value);
            }}
            className={cn(
              "h-7 shrink-0 cursor-pointer rounded-sm px-2.5 text-[13px] whitespace-nowrap tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:h-10",
              checked ? "bg-surface font-medium text-text shadow-card" : "text-muted hover:text-text",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
