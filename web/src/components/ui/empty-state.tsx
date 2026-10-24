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
        "flex flex-col items-start gap-1 rounded-md border border-line bg-surface px-4 py-6 text-left",
        className,
      )}
      {...props}
    >
      <Icon className="mb-1 size-4 text-muted" aria-hidden="true" />
      <h3 className="text-sm font-medium text-text">{title}</h3>
      {description ? <p className="max-w-prose text-[13px] text-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export { EmptyState };
