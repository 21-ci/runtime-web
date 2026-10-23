import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

import { applyTheme, readTheme, writeTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "System theme", Icon: Monitor },
  { value: "light", label: "Light theme", Icon: Sun },
  { value: "dark", label: "Dark theme", Icon: Moon },
];

// ThemeToggle is a radio group: arrow keys move the choice, the choice persists in localStorage.
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => readTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function choose(next: Theme) {
    writeTheme(next);
    setTheme(next);
  }

  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-[8px] border border-line bg-panel p-0.5">
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
            onClick={() => choose(value)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const i = OPTIONS.findIndex((o) => o.value === theme);
              const step = e.key === "ArrowRight" ? 1 : -1;
              choose(OPTIONS[(i + step + OPTIONS.length) % OPTIONS.length].value);
            }}
            className={cn(
              "grid size-7 place-items-center rounded-[6px] text-muted outline-none focus-visible:ring-2 focus-visible:ring-focus",
              checked && "bg-surface text-text shadow-sm",
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
