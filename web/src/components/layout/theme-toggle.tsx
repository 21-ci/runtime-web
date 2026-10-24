import { Monitor, Moon, Sun } from "lucide-react";

import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useShell } from "./shell-context";

const OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light theme", Icon: Sun },
  { value: "dark", label: "Dark theme", Icon: Moon },
  { value: "system", label: "System theme", Icon: Monitor },
];

// ThemeToggle is a segmented radio group: arrow keys move the choice. The choice lives in the
// shell state (persisted by AppShell), so the palette's "Toggle theme" and this control stay in sync.
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useShell();

  return (
    <div role="radiogroup" aria-label="Theme" className={cn("inline-flex h-7 rounded-md bg-panel-2 p-0.5", className)}>
      {OPTIONS.map(({ value, label, Icon }) => {
        const checked = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={label}
            title={label}
            tabIndex={checked ? 0 : -1}
            onClick={() => setTheme(value)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const i = OPTIONS.findIndex((o) => o.value === theme);
              const step = e.key === "ArrowRight" ? 1 : -1;
              setTheme(OPTIONS[(i + step + OPTIONS.length) % OPTIONS.length].value);
            }}
            className={cn(
              "grid h-6 w-7 cursor-pointer place-items-center rounded-[5px] text-muted outline-none transition-[background-color,color,box-shadow] duration-[120ms] hover:text-text focus-visible:ring-2 focus-visible:ring-focus",
              checked && "bg-surface-2 text-text shadow-card",
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
