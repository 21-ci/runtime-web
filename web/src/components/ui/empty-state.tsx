import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Inbox } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { Button } from "./button";
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
  variant?: "empty" | "no-range" | "error" | "permission";
  /** Error variant: the code from errors.json. */
  code?: string;
  /** Error variant: the raw message, collapsed. */
  details?: string;
  onRetry?: () => void;
}

function ErrorState({ title, description, code, details, onRetry, className, ...props }: EmptyStateProps) {
  const { t } = useTranslation("common");
  return (
    <div role="alert" className={cn("flex flex-col gap-2 rounded-lg border border-danger px-4 py-3 text-sm", className)} {...props}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-danger" />
        <p className="min-w-0 flex-1 font-medium text-text">{title}</p>
        {onRetry ? (
          <Button size="sm" onClick={onRetry}>
            {t("retry")}
          </Button>
        ) : null}
      </div>
      {description ? <p className="text-[13px] text-muted">{description}</p> : null}
      {code ? <code className="font-mono text-[12px] text-muted">{code}</code> : null}
      {details ? (
        <details className="text-[13px] text-muted">
          <summary className="cursor-pointer">{t("details")}</summary>
          <p className="mt-1 break-words font-mono text-[12px]">{details}</p>
        </details>
      ) : null}
    </div>
  );
}

// EmptyState holds the four states a list can be in without rows (guidelines rule 6). "empty": nothing yet, with one
// action. "no-range": the object exists and the window is empty, one sentence that names the range. "error": an inline
// alert. "permission": a muted notice beside disabled controls.
function EmptyState({
  variant = "empty",
  title,
  description,
  icon: Icon = Inbox,
  action,
  entity,
  hue,
  bare = false,
  code,
  details,
  onRetry,
  className,
  ...props
}: EmptyStateProps) {
  if (variant === "error") {
    return (
      <ErrorState
        title={title}
        {...(description !== undefined ? { description } : {})}
        {...(code !== undefined ? { code } : {})}
        {...(details !== undefined ? { details } : {})}
        {...(onRetry !== undefined ? { onRetry } : {})}
        {...(className !== undefined ? { className } : {})}
        {...props}
      />
    );
  }
  if (variant === "no-range") {
    return (
      <div className={cn("px-4 py-8 text-center text-sm text-muted", className)} {...props}>
        {title}
      </div>
    );
  }
  if (variant === "permission") {
    return (
      <div role="note" className={cn("text-[13px] text-muted", className)} {...props}>
        {title}
      </div>
    );
  }
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
