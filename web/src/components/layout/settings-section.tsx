import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

// SettingsSection is one block of a settings page: its title and purpose on the left, its controls
// on the right, stacked below md. A hairline separates it from the section above.
export function SettingsSection({
  title,
  description,
  headingId,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  headingId?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "grid min-w-0 gap-4 border-t border-line pt-6 first:border-t-0 first:pt-0 [header+&]:border-t-0 [header+&]:pt-0 md:grid-cols-[minmax(0,240px)_minmax(0,1fr)] md:gap-8",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 id={headingId} className="text-sm font-semibold text-text">
          {title}
        </h2>
        {description ? <p className="mt-0.5 break-words text-[13px] text-muted">{description}</p> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  );
}

// SettingsRows is a card of label and value rows split by hairlines.
export function SettingsRows({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("divide-y divide-line rounded-lg border border-line bg-surface shadow-card", className)}>{children}</dl>;
}

export function SettingsRow({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <dt className="min-w-0 sm:max-w-[50%] sm:shrink-0">
        <span className="block text-sm font-medium">{label}</span>
        {hint ? <span className="block text-[12px] text-muted">{hint}</span> : null}
      </dt>
      <dd className="flex min-w-0 flex-1 items-center gap-1 sm:justify-end">{children}</dd>
    </div>
  );
}
