import * as React from "react";

import { cn } from "@/lib/utils";

// SectionCard is a dashboard panel: white surface, hairline, 14px radius, header row with a bold
// title on the left and small controls (filter, "View all", ⋮) on the right.
function SectionCard({
  title,
  actions,
  className,
  children,
  ...props
}: Omit<React.HTMLAttributes<HTMLElement>, "title"> & { title: React.ReactNode; actions?: React.ReactNode }) {
  const id = React.useId();
  return (
    <section
      aria-labelledby={id}
      className={cn("flex min-w-0 flex-col rounded-xl border border-line bg-surface p-5", className)}
      {...props}
    >
      <header className="mb-3 flex min-h-8 items-center gap-2">
        <h2 id={id} className="mr-auto text-[15px] font-semibold text-text">
          {title}
        </h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

// SMALL_CONTROL is the lightly bordered, softly rounded style for filters and "View all".
const SMALL_CONTROL =
  "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 text-[13px] font-medium text-text outline-none transition-colors duration-[160ms] hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus data-[state=open]:bg-hover [&_svg]:size-3.5";

const SMALL_ICON =
  "inline-grid size-7 cursor-pointer place-items-center rounded-md border border-line-strong bg-surface text-muted outline-none transition-colors duration-[160ms] hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus data-[state=open]:bg-hover [&_svg]:size-4";

export { SectionCard, SMALL_CONTROL, SMALL_ICON };
