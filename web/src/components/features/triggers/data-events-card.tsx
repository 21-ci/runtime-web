import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

import { useAppView } from "@/components/features/app-header/hooks";
import { QueryError } from "@/components/features/empty/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCan } from "@/hooks/authz";
import { api } from "@/lib/api";

type Payload = "keys" | "row";
type Op = "insert" | "update" | "delete";
type TableRow = { name: string; ops: Op[]; payload: Payload };
type KvRow = { prefix: string; payload: Payload };

export interface DataEvents {
  state: "disabled" | "pending" | "active" | "paused_overflow" | "error";
  lag: number;
  backlog: number;
  last_error: string | null;
  tables: TableRow[];
  kv_prefixes?: KvRow[];
  topic: string | null;
}

const OPS: Op[] = ["insert", "update", "delete"];

function PayloadSelect({ value, label, onChange }: { value: Payload; label: string; onChange: (v: Payload) => void }) {
  const { t } = useTranslation("plans");
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Payload)}>
      <SelectTrigger aria-label={label} className="h-[34px] w-auto">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="keys">{t("events.payload.keys")}</SelectItem>
        <SelectItem value="row">{t("events.payload.row")}</SelectItem>
      </SelectContent>
    </Select>
  );
}

// DataEventsCard turns on data-change events. Reading the state needs only access to the App; the form is for those
// who could read the rows anyway, because events can carry them.
export function DataEventsCard({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation("plans");
  const view = useAppView(org, app);
  const can = useCan(org, view.data?.project);
  const canWrite = can("app.update") === true && can("app.data.read") === true;
  const qc = useQueryClient();
  const url = `/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}/data-events`;
  const key = ["data-events", org, app];
  const current = useQuery({ queryKey: key, queryFn: () => api.get<DataEvents>(url) });
  const save = useMutation({
    mutationFn: (body: object) => api.put<DataEvents>(url, body),
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      toast.success(t("events.saved"));
    },
  });
  const disable = useMutation({
    mutationFn: () => api.del<void>(url),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key });
      toast.success(t("events.disabled"));
    },
  });

  const data = current.data;
  const stateVariant = data?.state === "active" ? "success" : data?.state === "disabled" || data?.state === "pending" ? "outline" : "warning";

  return (
    <SectionCard
      title={t("events.title")}
      description={t("events.description")}
      actions={data ? <Badge variant={stateVariant}>{t(`events.state.${data.state}`)}</Badge> : undefined}
    >
      {current.isError ? (
        <QueryError error={current.error} onRetry={() => void current.refetch()} notFoundTitle={t("usage.unavailable")} />
      ) : !data ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <div className="flex flex-col gap-3">
          {data.state !== "disabled" ? <p className="text-[13px] text-muted">{t("events.backlog", { count: data.backlog })}</p> : null}
          {data.last_error ? <p className="text-sm text-danger">{data.last_error}</p> : null}
          {!canWrite ? (
            <p className="text-[13px] text-muted">{t("events.adminOnly")}</p>
          ) : (
            <EventsForm
              key={JSON.stringify([data.topic, data.tables, data.kv_prefixes])}
              data={data}
              saving={save.isPending}
              disabling={disable.isPending}
              onSave={(body) => save.mutate(body)}
              onDisable={() => disable.mutate()}
            />
          )}
        </div>
      )}
    </SectionCard>
  );
}

function EventsForm({
  data,
  saving,
  disabling,
  onSave,
  onDisable,
}: {
  data: DataEvents;
  saving: boolean;
  disabling: boolean;
  onSave: (body: object) => void;
  onDisable: () => void;
}) {
  const { t } = useTranslation("plans");
  const [topic, setTopic] = useState(data.topic ?? "");
  const [tables, setTables] = useState<TableRow[]>(data.tables ?? []);
  const [kv, setKv] = useState<KvRow[]>(data.kv_prefixes ?? []);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!topic.trim()) return setError(t("events.topicRequired"));
    const rows = tables.filter((r) => r.name.trim());
    if (rows.some((r) => r.ops.length === 0)) return setError(t("events.opsRequired"));
    setError(null);
    onSave({ topic: topic.trim(), tables: rows, kv_prefixes: kv.filter((r) => r.prefix.trim()) });
  }

  const patchTable = (i: number, p: Partial<TableRow>) => setTables(tables.map((r, n) => (n === i ? { ...r, ...p } : r)));
  const patchKv = (i: number, p: Partial<KvRow>) => setKv(kv.map((r, n) => (n === i ? { ...r, ...p } : r)));
  const anyRow = tables.some((r) => r.payload === "row") || kv.some((r) => r.payload === "row");

  return (
            <form onSubmit={onSubmit} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="data-events-topic">{t("events.topic")}</Label>
                <Input id="data-events-topic" value={topic} onChange={(e) => setTopic(e.target.value)} autoComplete="off" />
              </div>

              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-[13px] font-medium">{t("events.tables")}</legend>
                {tables.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <Input
                      aria-label={t("events.tableName")}
                      placeholder={t("events.tableName")}
                      className="w-44"
                      value={r.name}
                      onChange={(e) => patchTable(i, { name: e.target.value })}
                    />
                    {OPS.map((op) => (
                      <label key={op} className="flex items-center gap-1 text-sm">
                        <input
                          type="checkbox"
                          className="size-4 accent-accent"
                          checked={r.ops.includes(op)}
                          onChange={() => patchTable(i, { ops: r.ops.includes(op) ? r.ops.filter((o) => o !== op) : [...r.ops, op] })}
                        />
                        {t(`events.op.${op}`)}
                      </label>
                    ))}
                    <PayloadSelect value={r.payload} label={t("events.payloadLabel")} onChange={(payload) => patchTable(i, { payload })} />
                    <Button type="button" variant="ghost" onClick={() => setTables(tables.filter((_, n) => n !== i))}>
                      {t("events.remove")}
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="secondary" className="self-start" onClick={() => setTables([...tables, { name: "", ops: [...OPS], payload: "keys" }])}>
                  {t("events.addTable")}
                </Button>
              </fieldset>

              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-[13px] font-medium">{t("events.kv")}</legend>
                {kv.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <Input
                      aria-label={t("events.kvPrefix")}
                      placeholder={t("events.kvPrefix")}
                      className="w-44"
                      value={r.prefix}
                      onChange={(e) => patchKv(i, { prefix: e.target.value })}
                    />
                    <PayloadSelect value={r.payload} label={t("events.payloadLabel")} onChange={(payload) => patchKv(i, { payload })} />
                    <Button type="button" variant="ghost" onClick={() => setKv(kv.filter((_, n) => n !== i))}>
                      {t("events.remove")}
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="secondary" className="self-start" onClick={() => setKv([...kv, { prefix: "", payload: "keys" }])}>
                  {t("events.addKv")}
                </Button>
              </fieldset>

              {anyRow ? <p className="text-[13px] text-muted">{t("events.rowWarning")}</p> : null}
              {error ? (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={saving}>
                  {data.state === "paused_overflow" ? t("events.rearm") : t("events.save")}
                </Button>
                {data.state !== "disabled" ? (
                  <Button type="button" variant="secondary" disabled={disabling} onClick={onDisable}>
                    {t("events.disable")}
                  </Button>
                ) : null}
              </div>
            </form>
  );
}
