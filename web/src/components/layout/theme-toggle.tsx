import { Monitor, Moon, Sun } from "lucide-react";

import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useShell } from "./shell-context";

const OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "System theme", Icon: Monitor },
  { value: "light", label: "Light theme", Icon: Sun },
  { value: "dark", label: "Dark theme", Icon: Moon },
];

// ThemeToggle is a radio group: arrow keys move the choice. The choice lives in the shell state
// (persisted by AppShell), so the palette's "Toggle theme" and this control stay in sync.
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useShell();

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cn("inline-flex rounded-md border border-line bg-panel p-0.5", className)}
    >
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
              "grid size-6 cursor-pointer place-items-center rounded-sm text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus",
              checked && "bg-surface text-text ring-1 ring-line",
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
