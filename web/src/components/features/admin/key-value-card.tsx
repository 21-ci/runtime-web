import { Fragment, type ReactNode } from "react";

import { QueryError } from "@/components/features/empty/query-error";
import { Badge } from "@/components/ui/badge";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatQuantity, labelFor } from "@/lib/format";
import type { Json } from "./use-admin";

// renderValue shows a runtime value readably: booleans as badges, numbers with units guessed
// from the key, arrays as chips and nested objects as their own label/value rows.
function renderValue(key: string, value: unknown): ReactNode {
  if (value === null || value === undefined) return <span className="text-muted">-</span>;
  if (typeof value === "boolean") return <Badge variant={value ? "success" : "default"}>{value ? "yes" : "no"}</Badge>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted">none</span>;
    if (value.every((v) => v !== null && typeof v === "object" && !Array.isArray(v))) {
      return <ObjectTable rows={value as Record<string, unknown>[]} />;
    }
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((v, i) => (
          <Badge key={i} variant="outline" className="font-mono">
            {typeof v === "object" ? JSON.stringify(v) : String(v)}
          </Badge>
        ))}
      </span>
    );
  }
  if (typeof value === "object") return <Rows obj={value as Record<string, unknown>} nested />;
  return <span className="tabular-nums">{formatQuantity(key, value)}</span>;
}

// ObjectTable renders a list of same-shaped objects (processes, machines) as a compact table.
function ObjectTable({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  return (
    <div className="max-h-72 overflow-auto rounded-md border border-line">
      <table className="w-full text-[12px]">
        <thead className="sticky top-0 bg-panel text-left text-muted">
          <tr>
            {cols.map((c) => (
              <th key={c} className="h-7 whitespace-nowrap px-2 font-medium">
                {labelFor(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              {cols.map((c) => (
                <td key={c} className="whitespace-nowrap px-2 py-1 tabular-nums">
                  {renderValue(c, r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Rows({ obj, nested = false }: { obj: Record<string, unknown>; nested?: boolean }) {
  const entries = Object.entries(obj);
  if (entries.length === 0) return <span className="text-muted">empty</span>;
  return (
    <dl className={nested ? "grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[12px]" : "grid grid-cols-[minmax(120px,auto)_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm"}>
      {entries.map(([key, value]) => (
        <Fragment key={key}>
          <dt className="text-muted">{labelFor(key)}</dt>
          <dd className="min-w-0 break-words">{renderValue(key, value)}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

// KeyValueCard shows a runtime passthrough object as readable label/value rows. The runtime owns
// the shape, so every top-level field is listed as reported, with units inferred from key names.
export function KeyValueCard({
  title,
  query,
  footer,
}: {
  title: string;
  query: { data?: Json; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  footer?: ReactNode;
}) {
  return (
    <SectionCard title={title}>
      {query.isError ? (
        <QueryError error={query.error} onRetry={() => void query.refetch()} notFoundTitle="Not available" />
      ) : query.isPending ? (
        <div aria-busy="true">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        <Rows obj={(query.data ?? {}) as Record<string, unknown>} />
      )}
      {footer}
    </SectionCard>
  );
}
