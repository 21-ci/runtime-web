import * as React from "react";

import { cn } from "@/lib/utils";

// SectionCard is a dashboard panel: surface, hairline, 10px radius, a header row with a bold title
// on the left and small controls (filter, "View all", ⋮) on the right. `flush` drops the body
// padding so lists and tables can run edge to edge under the header. Text never widens the card:
// the title and description wrap, and the body grows to fill the card when a grid row stretches
// sibling cards to one height.
function SectionCard({
  title,
  description,
  actions,
  flush = false,
  className,
  children,
  ...props
}: Omit<React.HTMLAttributes<HTMLElement>, "title"> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  flush?: boolean;
}) {
  const id = React.useId();
  return (
    <section
      aria-labelledby={id}
      className={cn("flex min-w-0 flex-col rounded-lg border border-line bg-surface shadow-card", className)}
      {...props}
    >
      <header className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2 px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1 basis-40">
          <h2 id={id} className="break-words text-[15px] font-semibold text-text">
            {title}
          </h2>
          {description ? <p className="break-words text-[13px] text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
      </header>
      <div className={cn("min-w-0 flex-1", flush ? "border-t border-line" : "px-5 pb-5")}>{children}</div>
    </section>
  );
}

// SMALL_CONTROL is the lightly bordered, softly rounded style for filters and "View all".
const SMALL_CONTROL =
  "inline-flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-line-strong bg-surface-2 px-2.5 text-[13px] font-medium text-text outline-none transition-colors duration-[140ms] hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus data-[state=open]:bg-hover [&_svg]:size-3.5";

const SMALL_ICON =
  "inline-grid size-7 cursor-pointer place-items-center rounded-md border border-line-strong bg-surface-2 text-muted outline-none transition-colors duration-[140ms] hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus data-[state=open]:bg-hover [&_svg]:size-4";

export { SectionCard, SMALL_CONTROL, SMALL_ICON };
