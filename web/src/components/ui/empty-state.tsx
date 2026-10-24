import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import { IconTile, type Entity, type Hue } from "./icon-tile";

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  /** Colours the icon tile by entity type (see ENTITY_HUE). */
  entity?: Entity;
  hue?: Hue;
}

function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
  entity,
  hue,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-1.5 rounded-2xl border border-line bg-surface px-6 py-10 shadow-card text-center",
        className,
      )}
      {...props}
    >
      <IconTile icon={Icon} entity={entity} hue={hue ?? (entity ? undefined : "orange")} size="lg" className="mb-2" />
      <h3 className="text-[15px] font-semibold text-text">{title}</h3>
      {description ? <p className="max-w-prose text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export { EmptyState };
