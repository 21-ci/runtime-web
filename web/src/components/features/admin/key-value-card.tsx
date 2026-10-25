import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { QueryError } from "@/components/features/empty/query-error";
import { Badge } from "@/components/ui/badge";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatQuantity, labelFor, metricLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Json } from "./use-admin";

type Row = Record<string, unknown>;
type Query = { data?: Json; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };

// labelsFor names each key without its unit suffix (the value shows the unit), unless two keys
// would then read the same (queued and queued_bytes): those keep the full name.
function labelsFor(keys: string[]): Map<string, string> {
  const short = keys.map(metricLabel);
  return new Map(keys.map((k, i) => [k, short.indexOf(short[i]!) !== short.lastIndexOf(short[i]!) ? labelFor(k) : short[i]!]));
}

// isTable is true for a non-empty list of objects (processes, machines): those render as tables.
function isTable(value: unknown): value is Row[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => v !== null && typeof v === "object" && !Array.isArray(v))
  );
}

// splitFields separates table-shaped fields from the scalar and nested ones.
export function splitFields(obj: Row): { fields: [string, unknown][]; tables: [string, Row[]][] } {
  const fields: [string, unknown][] = [];
  const tables: [string, Row[]][] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (isTable(value)) tables.push([key, value]);
    else fields.push([key, value]);
  }
  return { fields, tables };
}

function chip(v: unknown): string {
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

// Word renders one of the small runtime-table words (yes, no, none, empty) in the UI language.
function Word({ k }: { k: "kv.yes" | "kv.no" | "kv.none" | "kv.empty" }) {
  const { t } = useTranslation("admin");
  return <>{t(k)}</>;
}

// renderValue shows a runtime value readably: booleans as badges, numbers with units guessed
// from the key, arrays as chips and nested objects as their own label/value rows. Long ids and
// hashes wrap inside their cell instead of pushing the card wider.
function renderValue(key: string, value: unknown): ReactNode {
  if (value === null || value === undefined) return <span className="text-muted">-</span>;
  if (typeof value === "boolean") {
    return <Badge variant={value ? "success" : "default"}><Word k={value ? "kv.yes" : "kv.no"} /></Badge>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted"><Word k="kv.none" /></span>;
    if (isTable(value)) return <ObjectTable rows={value} inset />;
    return (
      <span className="flex min-w-0 flex-wrap gap-1">
        {value.map((v, i) => (
          <Badge key={i} variant="outline" className="max-w-full font-mono">
            <span className="truncate" title={chip(v)}>
              {chip(v)}
            </span>
          </Badge>
        ))}
      </span>
    );
  }
  if (typeof value === "object") return <Rows entries={Object.entries(value as Row)} nested />;
  // Numbers keep their unit on one line; free text (ids, hashes) may break anywhere.
  if (typeof value === "number") return <span className="whitespace-nowrap tabular-nums">{formatQuantity(key, value)}</span>;
  return <span className="break-all">{formatQuantity(key, value)}</span>;
}

// ObjectTable renders a list of same-shaped objects as a compact table that scrolls inside its own
// frame. `inset` adds a hairline frame for a table nested in a value cell.
export function ObjectTable({ rows, inset = false, label }: { rows: Row[]; inset?: boolean; label?: string }) {
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const labels = labelsFor(cols);
  return (
    <div className={cn("min-w-0", inset && "max-h-72 overflow-y-auto rounded-md border border-line")}>
      <Table bare className="text-[13px]">
        {label ? <caption className="sr-only">{label}</caption> : null}
        <TableHeader className="sticky top-0 z-[1]">
          <TableRow className="hover:bg-transparent">
            {cols.map((c) => (
              <TableHead key={c} className="h-8 whitespace-nowrap">
                {labels.get(c)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              {cols.map((c) => (
                <TableCell key={c} className="h-8 whitespace-nowrap py-1 tabular-nums">
                  {renderValue(c, r[c])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Rows({ entries, nested = false }: { entries: [string, unknown][]; nested?: boolean }) {
  if (entries.length === 0) return <span className="text-muted"><Word k="kv.empty" /></span>;
  const labels = labelsFor(entries.map(([k]) => k));
  return (
    <dl
      className={
        nested
          ? "grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[13px]"
          : "grid min-w-0 grid-cols-[fit-content(40%)_minmax(0,1fr)] gap-x-8 gap-y-2.5 text-sm"
      }
    >
      {entries.map(([key, value]) => (
        <Fragment key={key}>
          <dt className="min-w-0 break-words text-muted">{labels.get(key)}</dt>
          <dd className="min-w-0 break-words">{renderValue(key, value)}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function Pending({ h = "h-16" }: { h?: string }) {
  return (
    <div aria-busy="true">
      <Skeleton className={cn(h, "w-full")} />
    </div>
  );
}

// KeyValueCard shows a runtime passthrough object as readable label/value rows. The runtime owns
// the shape, so every top-level field is listed as reported, with units inferred from key names.
// List fields render as full-width tables under the rows; `tables="omit"` leaves them to
// KeyValueTables so a page can lay them out at full width below a row of summary cards. The card
// fills its grid cell (h-full) so cards in one row share a height.
export function KeyValueCard({
  title,
  description,
  query,
  footer,
  tables = "inline",
  className,
}: {
  title: string;
  description?: ReactNode;
  query: Query;
  footer?: ReactNode;
  tables?: "inline" | "omit";
  className?: string;
}) {
  const { t } = useTranslation("admin");
  const split = splitFields((query.data ?? {}) as Row);
  return (
    <SectionCard title={title} description={description} className={cn("h-full", className)}>
      {query.isError ? (
        <QueryError error={query.error} onRetry={() => void query.refetch()} notFoundTitle={t("notAvailable")} />
      ) : query.isPending ? (
        <Pending />
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
          <Rows entries={split.fields} />
          {tables === "inline"
            ? split.tables.map(([key, rows]) => (
                <div key={key} className="flex min-w-0 flex-col gap-1.5">
                  <p className="text-[13px] font-medium text-muted">{metricLabel(key)}</p>
                  <ObjectTable rows={rows} inset label={metricLabel(key)} />
                </div>
              ))
            : null}
        </div>
      )}
      {footer}
    </SectionCard>
  );
}

// KeyValueTables renders each list field of a runtime object as its own full-width card with an
// edge-to-edge table (the counterpart of KeyValueCard tables="omit").
export function KeyValueTables({ query, source }: { query: Query; source: string }) {
  const { t } = useTranslation("admin");
  if (query.isError) return null;
  if (query.isPending) return <Pending h="h-40" />;
  const { tables } = splitFields((query.data ?? {}) as Row);
  return (
    <>
      {tables.map(([key, rows]) => (
        <SectionCard
          key={key}
          title={metricLabel(key)}
          description={t("kv.rowsSource", { count: rows.length, source })}
          flush
        >
          <ObjectTable rows={rows} label={t("kv.caption", { source, metric: metricLabel(key) })} />
        </SectionCard>
      ))}
    </>
  );
}
