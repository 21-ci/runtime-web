import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
}

function EmptyState({ title, description, icon: Icon = Inbox, action, className, ...props }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-line-strong bg-panel px-6 py-10 text-center",
        className,
      )}
      {...props}
    >
      <Icon className="size-8 text-muted" aria-hidden="true" />
      <h3 className="text-base font-semibold text-text">{title}</h3>
      {description ? <p className="max-w-sm text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export { EmptyState };
