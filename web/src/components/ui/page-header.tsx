import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { IconTile, type Entity } from "./icon-tile";

// PageHeader is the title row of a page: entity tile, h1, optional description and actions.
export function PageHeader({
  icon,
  entity,
  title,
  description,
  actions,
  className,
}: {
  icon?: LucideIcon;
  entity?: Entity;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-center gap-3", className)}>
      {icon ? <IconTile icon={icon} entity={entity} size="md" /> : null}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-xl font-semibold tracking-[-0.01em] text-text">{title}</h1>
        {description ? <p className="text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

// SectionLabel is the small uppercase label that opens a settings group (val.town style).
export function SectionLabel({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <h2
      id={id}
      className={cn("border-b border-line pb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted", className)}
    >
      {children}
    </h2>
  );
}

// StatTile shows one number with a label (overview stats, queue depth).
export function StatTile({
  label,
  value,
  hint,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5 rounded-lg border border-line bg-surface p-3.5 shadow-card", className)}>
      <dt className="truncate text-[12px] font-medium text-muted">{label}</dt>
      <dd className="truncate text-xl font-semibold tabular-nums tracking-[-0.01em] text-text">{value}</dd>
      {hint ? <span className="text-[12px] text-muted">{hint}</span> : null}
    </div>
  );
}

// Kbd renders a keyboard hint.
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("rounded-sm border border-line bg-panel-2 px-1 font-mono text-[11px] text-muted", className)}>
      {children}
    </kbd>
  );
}
