import { Fragment, type ReactNode } from "react";

import { QueryError } from "@/components/features/empty/query-error";
import { Skeleton } from "@/components/ui/skeleton";
import type { Json } from "./use-admin";

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// KeyValueCard shows a runtime passthrough object as label/value rows. The runtime owns the shape,
// so every top-level field is listed as reported.
export function KeyValueCard({
  title,
  query,
  footer,
}: {
  title: string;
  query: { data?: Json; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  footer?: ReactNode;
}) {
  const headingId = `kv-${title.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <section aria-labelledby={headingId} className="rounded-md border border-line bg-surface p-4">
      <h2 id={headingId} className="mb-3 text-base font-semibold">
        {title}
      </h2>
      {query.isError ? (
        <QueryError error={query.error} onRetry={() => void query.refetch()} notFoundTitle="Not available" />
      ) : query.isPending ? (
        <div aria-busy="true">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {Object.entries(query.data ?? {}).map(([key, value]) => (
            <Fragment key={key}>
              <dt className="text-muted">{key}</dt>
              <dd className="break-all tabular-nums">{formatValue(value)}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {footer}
    </section>
  );
}
