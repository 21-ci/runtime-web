import * as React from "react";

import { cn } from "@/lib/utils";

// Table wraps real table markup in a bordered 10px frame. `bare` skips the frame so a table can sit
// inside a SectionCard with flush body.
const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement> & { bare?: boolean }>(
  ({ className, bare = false, ...props }, ref) => (
    <div
      className={cn(
        "relative w-full overflow-x-auto",
        !bare && "rounded-lg border border-line bg-surface shadow-card",
      )}
    >
      <table ref={ref} className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  ),
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <thead ref={ref} className={cn(className)} {...props} />,
);
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />,
);
TableBody.displayName = "TableBody";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr ref={ref} className={cn("group border-b border-line transition-colors hover:bg-hover", className)} {...props} />
  ),
);
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        "h-9 border-b border-line bg-panel px-3 text-left align-middle text-[12px] font-medium text-muted first:pl-4 last:pr-4",
        className,
      )}
      {...props}
    />
  ),
);
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td ref={ref} className={cn("h-10 px-3 py-2 align-middle first:pl-4 last:pr-4", className)} {...props} />
  ),
);
TableCell.displayName = "TableCell";

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow };
