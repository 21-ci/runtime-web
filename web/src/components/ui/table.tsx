import * as React from "react";

import { cn } from "@/lib/utils";

import { Bounded } from "./bounded";

function labelCells(table: HTMLTableElement) {
  const heads = Array.from(table.tHead?.rows[0]?.cells ?? [], (th) => th.textContent ?? "");
  for (const body of Array.from(table.tBodies)) {
    for (const row of Array.from(body.rows)) {
      Array.from(row.cells).forEach((cell, i) => {
        // A spanning cell (an empty note, an expanded detail) is not one column's field.
        if (cell.colSpan > 1) cell.removeAttribute("data-label");
        else cell.setAttribute("data-label", heads[i] ?? "");
      });
    }
  }
}

// Table wraps real table markup in a bordered 10px frame. `bare` skips the frame so a table can sit
// inside a SectionCard with flush body. The frame is the horizontal scroll container (never the
// page): a table wider than its card scrolls inside it, with an edge shadow on the side that has
// more columns.
//
// `stack` (guidelines rules 5 and 13): under md each row becomes a card of labelled fields, in column order, styled by
// .table-stack in index.css. The labels are read from the header row, so they cannot drift from it.
const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement> & { bare?: boolean; stack?: boolean }>(
  ({ className, bare = false, stack = false, ...props }, ref) => {
    const own = React.useRef<HTMLTableElement | null>(null);
    React.useImperativeHandle(ref, () => own.current as HTMLTableElement);
    React.useLayoutEffect(() => {
      if (stack && own.current) labelCells(own.current);
    });
    return (
      <div className={cn("w-full min-w-0 max-w-full", !bare && "overflow-hidden rounded-lg border border-line shadow-card")}>
        <Bounded>
          <div className="scroll-shadow-x relative w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain">
            <table ref={own} className={cn("w-full caption-bottom text-sm", stack && "table-stack", className)} {...props} />
          </div>
        </Bounded>
      </div>
    );
  },
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
