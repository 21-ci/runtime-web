import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

import { Button } from "./button";
import { Skeleton } from "./skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

export interface DataColumn<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Numbers and dates are right-aligned and use tabular figures. */
  align?: "left" | "right";
  /** The name column: may wrap. Every other cell truncates. */
  primary?: boolean;
  /** Tooltip of a truncated cell. */
  title?: (row: T) => string;
  /** Makes the column sortable. */
  sortValue?: (row: T) => string | number;
}

export interface DataSort {
  key: string;
  dir: "asc" | "desc";
}

export interface DataTableProps<T> {
  /** Accessible name of the table. */
  label: string;
  columns: readonly DataColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** "12 apps", "3 of 48". */
  count?: ReactNode;
  /** The filter row, above the table. */
  toolbar?: ReactNode;
  /** Rows shown per page when the rows are all held on the client. */
  pageSize?: number;
  /** Cursor paging: the server has more, onLoadMore fetches them. */
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  loading?: boolean;
  empty?: ReactNode;
  /** Given with onSortChange, the server sorts and the rows stay in the order they come. */
  sort?: DataSort;
  onSortChange?: (sort: DataSort) => void;
  className?: string;
}

const compare = (a: string | number, b: string | number) =>
  typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));

// DataTable is the console's table (guidelines rule 5), on the table.tsx primitive, whose frame already scrolls inside
// a bounded height with a sticky-free header row. Under md a table of more than three columns becomes labelled cards,
// from one markup so the fields and their order cannot drift.
export function DataTable<T>({
  label,
  columns,
  rows,
  rowKey,
  count,
  toolbar,
  pageSize = 20,
  hasMore = false,
  onLoadMore,
  loadingMore = false,
  loading = false,
  empty,
  sort,
  onSortChange,
  className,
}: DataTableProps<T>) {
  const { t } = useTranslation("common");
  const [ownSort, setOwnSort] = useState<DataSort | null>(null);
  const [limit, setLimit] = useState(pageSize);
  const controlled = onSortChange !== undefined;
  const active = controlled ? (sort ?? null) : ownSort;

  const ordered = useMemo(() => {
    const col = !controlled && active ? columns.find((c) => c.key === active.key) : undefined;
    if (!col?.sortValue) return rows;
    const value = col.sortValue;
    const sign = active?.dir === "desc" ? -1 : 1;
    return [...rows].sort((a, b) => sign * compare(value(a), value(b)));
  }, [rows, columns, active, controlled]);

  const clientPaged = !onLoadMore;
  const visible = clientPaged ? ordered.slice(0, limit) : ordered;
  const more = clientPaged ? ordered.length > limit : hasMore;
  const stacked = columns.length > 3;

  function toggle(key: string) {
    const next: DataSort = { key, dir: active?.key === key && active.dir === "asc" ? "desc" : "asc" };
    if (controlled) onSortChange(next);
    else setOwnSort(next);
  }

  const header = count != null || toolbar != null ? (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{toolbar}</div>
      {count != null ? <span className="text-[13px] tabular-nums text-muted">{count}</span> : null}
    </div>
  ) : null;

  if (!loading && rows.length === 0 && empty != null) {
    return (
      <div className={cn("flex min-w-0 flex-col gap-3", className)}>
        {header}
        {empty}
      </div>
    );
  }

  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)}>
      {header}
      <Table aria-label={label} stack={stacked}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((c) => {
              const dir = active?.key === c.key ? active.dir : null;
              const Icon = dir === "asc" ? ArrowUp : dir === "desc" ? ArrowDown : ChevronsUpDown;
              return (
                <TableHead
                  key={c.key}
                  scope="col"
                  aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined}
                  className={cn(c.align === "right" && "text-right")}
                >
                  {c.sortValue ? (
                    <button
                      type="button"
                      onClick={() => toggle(c.key)}
                      className={cn("inline-flex cursor-pointer items-center gap-1 rounded-sm outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus", c.align === "right" && "flex-row-reverse")}
                    >
                      {c.header}
                      <Icon aria-hidden="true" className="size-3" />
                    </button>
                  ) : (
                    c.header
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading
            ? Array.from({ length: 5 }, (_, i) => (
                <TableRow key={i} aria-hidden="true">
                  {columns.map((c) => (
                    <TableCell key={c.key}>
                      <Skeleton className="h-4 w-full max-w-40" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            : visible.map((row) => (
                <TableRow key={rowKey(row)}>
                  {columns.map((c) => (
                    <TableCell
                      key={c.key}
                      title={c.title?.(row)}
                      className={cn(c.align === "right" && "text-right tabular-nums", !c.primary && "max-w-64 truncate")}
                    >
                      {c.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
        </TableBody>
      </Table>
      {more ? (
        <div className="flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            disabled={loadingMore}
            onClick={() => (clientPaged ? setLimit(limit + pageSize) : onLoadMore())}
          >
            {t("loadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
