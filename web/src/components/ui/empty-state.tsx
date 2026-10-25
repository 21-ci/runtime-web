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
  /** Renders without its own frame, for use inside a card. */
  bare?: boolean;
}

// EmptyState explains an empty list in one line and offers one action.
function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
  entity,
  hue,
  bare = false,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-1.5 px-6 py-10 text-center",
        !bare && "rounded-lg border border-line bg-surface shadow-card",
        className,
      )}
      {...props}
    >
      <IconTile icon={Icon} entity={entity} hue={hue ?? (entity ? undefined : "gray")} size="lg" className="mb-2" />
      <h3 className="text-[15px] font-semibold text-text">{title}</h3>
      {description ? <p className="max-w-[44ch] text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export { EmptyState };
