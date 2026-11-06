import { useMutation, useQuery } from "@tanstack/react-query";
import { Database } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { QueryError } from "@/components/features/empty/query-error";
import { BoundedList } from "@/components/ui/bounded";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCan } from "@/hooks/authz";
import { api, ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/error-message";
import { formatDateTime } from "@/lib/format";

import { ExportDataButton } from "./export-data";

// Shapes from docs/reference/api.md §8.7.
type DataTable = { name: string; type: string; columns: { name: string; type: string; pk: number | boolean }[]; rows_estimate: number | null };
export type QueryResult = { columns: string[]; rows: unknown[][]; truncated: boolean; elapsed_ms: number };
type KvItem = { key: string; key_b64: string; type: string; size: number; expires_at: number | null; preview: unknown };
type KvValue = { key: string; type: string; size: number; value: unknown; truncated: boolean };
type BlobItem = { key: string; size: number; content_type: string };
type Listed<I> = { items: I[]; next_cursor?: string | null };

const PAGE = 100;
/** Rows of one result drawn at a time; the rest are already here and appear on request. */
const RESULT_PAGE = 200;

/** SQLite identifier quoting, so a table named by anyone cannot change what a generated statement does. */
export const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** One page in primary key order: the key of the last row seen starts the next, so paging never counts rows. */
export function browseSql(t: Pick<DataTable, "name" | "columns">, after: unknown): { sql: string; args: unknown[] } {
  const pk = t.columns.find((c) => Boolean(c.pk));
  const table = quoteIdent(t.name);
  if (!pk) return { sql: `SELECT * FROM ${table} LIMIT ${PAGE}`, args: [] };
  const col = quoteIdent(pk.name);
  return after === undefined
    ? { sql: `SELECT * FROM ${table} ORDER BY ${col} LIMIT ${PAGE}`, args: [] }
    : { sql: `SELECT * FROM ${table} WHERE ${col} > ?1 ORDER BY ${col} LIMIT ${PAGE}`, args: [after] };
}

/** Always text: cells are someone's data. Encoded forms from the runtime's rendering rules show what they stand for. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object") {
    const o = v as { $blob?: unknown; hex?: unknown; $text?: unknown; truncated?: unknown };
    if (o.$blob !== undefined) return `BLOB(${String(o.$blob)}) ${typeof o.hex === "string" ? o.hex : ""}`.trim();
    if (typeof o.$text === "string") return `${o.$text}…`;
    return JSON.stringify(v);
  }
  return String(v);
}

/** Whether the text holds a second statement. Quotes and comments are skipped; a trailing semicolon is not a second. */
export function severalStatements(sql: string): boolean {
  const bare = sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
  return bare.replace(/[;\s]+$/, "").includes(";");
}

/** The refusal in terms of what was typed. The runtime uses one code for a write and for two statements. */
function sqlMessage(err: unknown, sql: string, t: (key: "data.oneStatement" | "data.readOnly") => string): string {
  if (err instanceof ApiError && err.code === "sql_not_readonly") return t(severalStatements(sql) ? "data.oneStatement" : "data.readOnly");
  return errorMessage(err);
}

const MS_RANGE = [1e12, 1e13] as const;
const SECONDS_RANGE = [1e9, 1e10] as const;
const TIME_NAME = /(_at|_ts|time|date)$/i;

/** A hover text for a number that reads as a date. Seconds count only in a column named like a time. */
export function timestampHint(column: string, v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  let ms: number | null = null;
  if (v >= MS_RANGE[0] && v < MS_RANGE[1]) ms = v;
  else if (TIME_NAME.test(column) && v >= SECONDS_RANGE[0] && v < SECONDS_RANGE[1]) ms = v * 1000;
  return ms === null ? null : `${new Date(ms).toISOString()} · ${formatDateTime(ms)}`;
}

/** Duplicate names stay apart: `select 1 as a, 2 as a` has two different columns. */
function distinctHeaders(columns: string[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((c) => {
    const n = (seen.get(c) ?? 0) + 1;
    seen.set(c, n);
    return n === 1 ? c : `${c} (${n})`;
  });
}

function csvCell(v: unknown): string {
  let s = cellText(v);
  // A cell that starts like a formula would run when the file is opened in a spreadsheet.
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(result: QueryResult): string {
  return [result.columns, ...result.rows].map((row) => `${row.map(csvCell).join(",")}\r\n`).join("");
}

function downloadCsv(result: QueryResult) {
  const url = URL.createObjectURL(new Blob([toCsv(result)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "query-result.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function ResultTable({ result, types }: { result: QueryResult; types?: Record<string, string> }) {
  const { t } = useTranslation("platform");
  const { t: te } = useTranslation("empty");
  const { t: tc } = useTranslation("common");
  const [limit, setLimit] = useState(RESULT_PAGE);
  const [seen, setSeen] = useState(result);
  if (seen !== result) {
    setSeen(result);
    setLimit(RESULT_PAGE);
  }
  const headers = distinctHeaders(result.columns);
  const shown = result.rows.slice(0, limit);
  return (
    <div className="flex flex-col gap-2">
      <Table stack={headers.length > 3}>
        <TableHeader>
          <TableRow>
            {headers.map((h, i) => {
              const type = types?.[result.columns[i] ?? ""];
              return (
                <TableHead key={i}>
                  {h}
                  {type ? <span className="ml-1.5 font-mono text-[11px] font-normal text-muted">{type}</span> : null}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((row, i) => (
            <TableRow key={i}>
              {row.map((v, j) => (
                <TableCell key={j} title={timestampHint(result.columns[j] ?? "", v) ?? undefined} className="max-w-xs truncate font-mono text-[13px]">
                  {cellText(v)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {shown.length < result.rows.length ? (
        <div className="flex flex-wrap items-center justify-center gap-3">
          <p className="text-xs text-muted">{te("data.showing", { shown: shown.length, total: result.rows.length })}</p>
          <Button size="sm" variant="ghost" onClick={() => setLimit(limit + RESULT_PAGE)}>
            {tc("loadMore")}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs text-muted">
          {t("data.rows", { count: result.rows.length, ms: result.elapsed_ms })}
          {result.truncated ? ` ${t("data.truncated")}` : ""}
        </p>
        {result.rows.length > 0 ? (
          <Button size="sm" variant="secondary" onClick={() => downloadCsv(result)}>
            {t("data.csv")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// DataBrowser is read-only by design: the runtime refuses anything but one reading statement.
export function DataBrowser({ org, app, project }: { org: string; app: string; project: string | undefined }) {
  const { t } = useTranslation("platform");
  const { t: te } = useTranslation("empty");
  const allowed = useCan(org, project)("app.data.read");
  if (allowed === false) return <EmptyState icon={Database} title={t("data.adminsOnly")} description={t("data.adminsOnlyHint")} />;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader icon={Database} entity="settings" title={t("data.title")} description={t("data.description")} />
      <Tables org={org} app={app} />
      <SqlBox org={org} app={app} />
      <Kv org={org} app={app} />
      <Blobs org={org} app={app} />
      <SectionCard title={te("data.exportTitle")} description={te("data.exportHint")} actions={<ExportDataButton org={org} app={app} />}>
        {null}
      </SectionCard>
    </div>
  );
}

const path = (org: string, app: string) => `/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}/data`;

function Tables({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation("platform");
  const tables = useQuery({ queryKey: ["data", org, app, "tables"], queryFn: () => api.get<{ items: DataTable[] }>(`${path(org, app)}/tables`) });
  const [picked, setPicked] = useState<DataTable | null>(null);
  const [pages, setPages] = useState<unknown[]>([]);
  const read = useMutation({
    meta: { skipGlobalError: true },
    mutationFn: ({ table, after }: { table: DataTable; after: unknown }) => api.post<QueryResult>(`${path(org, app)}/query`, browseSql(table, after)),
  });
  const pk = picked?.columns.findIndex((c) => Boolean(c.pk)) ?? -1;
  const open = (table: DataTable, after?: unknown, back = false) => {
    setPicked(table);
    if (after === undefined) setPages([]);
    else if (!back) setPages([...pages, after]);
    read.mutate({ table, after });
  };
  const rows = read.data?.rows ?? [];
  const lastKey = pk >= 0 ? rows.at(-1)?.[pk] : undefined;
  return (
    <SectionCard title={t("data.tables")}>
      {tables.isError ? (
        <QueryError error={tables.error} onRetry={() => void tables.refetch()} notFoundTitle={t("data.notFound")} />
      ) : !tables.data ? (
        <Skeleton className="h-16 w-full" />
      ) : tables.data.items.length === 0 ? (
        <p className="text-sm text-muted">{t("data.noTables")}</p>
      ) : (
        <ul className="mb-4 flex flex-wrap gap-2">
          {tables.data.items.map((x) => (
            <li key={x.name}>
              <Button size="sm" variant={picked?.name === x.name ? "default" : "secondary"} onClick={() => open(x)}>
                {x.name}
                {x.rows_estimate !== null ? ` (~${x.rows_estimate})` : ""}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {read.isError ? <p className="text-sm text-danger" role="alert">{errorMessage(read.error)}</p> : null}
      {read.data ? <ResultTable result={read.data} types={Object.fromEntries((picked?.columns ?? []).map((c) => [c.name, c.type]))} /> : null}
      {picked && read.data ? (
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="secondary" disabled={pages.length === 0} onClick={() => {
            const prev = pages.slice(0, -1);
            setPages(prev);
            read.mutate({ table: picked, after: prev.at(-1) });
          }}>{t("data.prev")}</Button>
          <Button size="sm" variant="secondary" disabled={lastKey === undefined || rows.length < PAGE} onClick={() => open(picked, lastKey)}>{t("data.next")}</Button>
        </div>
      ) : null}
    </SectionCard>
  );
}

function SqlBox({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation("platform");
  const [sql, setSql] = useState("");
  const run = useMutation({ meta: { skipGlobalError: true }, mutationFn: (s: string) => api.post<QueryResult>(`${path(org, app)}/query`, { sql: s }) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (sql.trim()) run.mutate(sql);
  };
  return (
    <SectionCard title={t("data.query")}>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <Label htmlFor="data-sql">{t("data.sql")}</Label>
        <textarea
          id="data-sql"
          value={sql}
          rows={4}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setSql(e.target.value)}
          className="rounded-sm border border-line-strong bg-surface p-2 font-mono text-sm text-text focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus"
        />
        <p className="text-xs text-muted">{t("data.sqlHint")}</p>
        <div><Button type="submit" disabled={run.isPending || !sql.trim()}>{t("data.run")}</Button></div>
      </form>
      {run.isError ? <p className="mt-2 text-sm text-danger" role="alert">{sqlMessage(run.error, run.variables ?? sql, t)}</p> : null}
      {run.data ? <div className="mt-4"><ResultTable result={run.data} /></div> : null}
    </SectionCard>
  );
}

function Kv({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation("platform");
  const { t: te } = useTranslation("empty");
  const [prefix, setPrefix] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const qs = new URLSearchParams();
  if (prefix) qs.set("prefix", prefix);
  if (cursor) qs.set("cursor", cursor);
  const list = useQuery({ queryKey: ["data", org, app, "kv", prefix, cursor], queryFn: () => api.get<Listed<KvItem>>(`${path(org, app)}/kv?${qs.toString()}`) });
  const value = useMutation({ meta: { skipGlobalError: true }, mutationFn: (b64: string) => api.get<KvValue>(`${path(org, app)}/kv/${encodeURIComponent(b64)}`) });
  return (
    <SectionCard title={t("data.kv")}>
      <div className="mb-3 flex max-w-sm flex-col gap-1.5">
        <Label htmlFor="data-kv-prefix">{t("data.prefix")}</Label>
        <Input id="data-kv-prefix" value={prefix} autoComplete="off" onChange={(e) => { setPrefix(e.target.value); setCursor(null); }} />
        <p className="text-xs text-muted">{t("data.kvHint")}</p>
      </div>
      {list.isError ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} notFoundTitle={t("data.notFound")} />
      ) : !list.data ? (
        <Skeleton className="h-16 w-full" />
      ) : list.data.items.length === 0 ? (
        <p className="text-sm text-muted">{te(prefix ? "data.noKeysPrefix" : "data.noKeys")}</p>
      ) : (
        <BoundedList className="flex flex-col gap-1 text-sm">
          {list.data.items.map((k) => (
            <li key={k.key_b64} className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => value.mutate(k.key_b64)}>{k.key}</Button>
              <span className="text-xs text-muted">{k.type}, {k.size} B</span>
              <span className="truncate font-mono text-xs">{cellText(k.preview)}</span>
            </li>
          ))}
        </BoundedList>
      )}
      {list.data?.next_cursor ? <Button className="mt-2" size="sm" variant="secondary" onClick={() => setCursor(list.data?.next_cursor ?? null)}>{t("data.next")}</Button> : null}
      {value.isError ? <p className="mt-2 text-sm text-danger" role="alert">{errorMessage(value.error)}</p> : null}
      {value.data ? (
        <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-panel-2 p-2 font-mono text-[13px] whitespace-pre-wrap break-all">
          {cellText(value.data.value)}
          {value.data.truncated ? `\n${t("data.truncated")}` : ""}
        </pre>
      ) : null}
    </SectionCard>
  );
}

function Blobs({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation("platform");
  const { t: te } = useTranslation("empty");
  const [cursor, setCursor] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["data", org, app, "blobs", cursor],
    queryFn: () => api.get<Listed<BlobItem>>(`${path(org, app)}/blobs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  });
  return (
    <SectionCard title={t("data.blobs")}>
      {list.isError ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} notFoundTitle={t("data.notFound")} />
      ) : !list.data ? (
        <Skeleton className="h-16 w-full" />
      ) : list.data.items.length === 0 ? (
        <p className="text-sm text-muted">{te("data.noFiles")}</p>
      ) : (
        <BoundedList className="flex flex-col gap-1 text-sm">
          {list.data.items.map((b) => <li key={b.key} className="font-mono break-all">{b.key} <span className="text-xs text-muted">{b.content_type}, {b.size} B</span></li>)}
        </BoundedList>
      )}
      {list.data?.next_cursor ? <Button className="mt-2" size="sm" variant="secondary" onClick={() => setCursor(list.data?.next_cursor ?? null)}>{t("data.next")}</Button> : null}
    </SectionCard>
  );
}
