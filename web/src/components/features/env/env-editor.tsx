import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Eye, EyeOff, FileText, Lock, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { QueryError } from "@/components/features/empty/query-error";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { KeyValueRows, objectFromRows, type KvRow } from "@/components/ui/key-value-rows";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard, SMALL_CONTROL } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyButton } from "@/components/ui/url-bar";
import { api, ApiError } from "@/lib/api";
import { i18n } from "@/lib/i18n";
import { handleMutationError } from "@/lib/query";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function appPath(org: string, app: string) {
  return `/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}`;
}

// toEnvText renders the env map as KEY=VALUE lines, sorted by key.
export function toEnvText(env: Record<string, string>): string {
  return Object.keys(env)
    .sort()
    .map((k) => `${k}=${env[k]}`)
    .join("\n");
}

// parseEnvText reads KEY=VALUE lines. Blank lines and # comments are skipped. Returns the map
// or a message naming the first bad line.
export function parseEnvText(text: string): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = eq === -1 ? "" : line.slice(0, eq).trim();
    if (!KEY_PATTERN.test(key)) return { error: i18n.t("env:parse.badLine", { line: i + 1 }) };
    env[key] = line.slice(eq + 1);
  }
  return { env };
}

// envEtag mirrors the server's env ETag (SHA-256 over the entries sorted by key, first 16 bytes),
// so writes can send If-Match without reading response headers.
export async function envEtag(env: Record<string, string>): Promise<string> {
  const canon = JSON.stringify(Object.keys(env).sort().map((k) => [k, env[k]]));
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon)));
  return `"${Array.from(d.subarray(0, 16), (x) => x.toString(16).padStart(2, "0")).join("")}"`;
}

type EnvState = { env: Record<string, string>; etag: string };

export function useEnv(org: string, app: string) {
  return useQuery({
    queryKey: ["env", org, app],
    queryFn: async (): Promise<EnvState> => {
      const { env } = await api.get<{ env: Record<string, string> }>(`${appPath(org, app)}/env`);
      return { env, etag: await envEtag(env) };
    },
  });
}

// A 412 means someone changed the env since it was read: reload it and say so instead of overwriting.
function useEnvWrite<V>(org: string, app: string, send: (v: V) => Promise<{ env: Record<string, string> }>) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipGlobalError: true },
    mutationFn: send,
    onSuccess: async (res) => {
      toast.success(i18n.t("env:toast.saved"));
      qc.setQueryData<EnvState>(["env", org, app], { env: res.env, etag: await envEtag(res.env) });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 412) {
        toast.error(i18n.t("env:toast.conflict"));
        void qc.invalidateQueries({ queryKey: ["env", org, app] });
      } else handleMutationError(err);
    },
  });
}

// useSaveEnv replaces the whole map (text mode, import) under the etag it was read with.
export function useSaveEnv(org: string, app: string) {
  return useEnvWrite(org, app, (v: { env: Record<string, string>; etag: string }) =>
    api.put<{ env: Record<string, string> }>(`${appPath(org, app)}/env`, { env: v.env }, { ifMatch: v.etag }),
  );
}

// usePatchEnv sets or unsets single keys (row edits), so other keys changed meanwhile are kept.
export function usePatchEnv(org: string, app: string) {
  return useEnvWrite(org, app, (v: { set?: Record<string, string>; unset?: string[]; etag: string }) =>
    api.patch<{ env: Record<string, string> }>(
      `${appPath(org, app)}/env`,
      { set: v.set ?? {}, unset: v.unset ?? [] },
      { ifMatch: v.etag },
    ),
  );
}

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// EnvEditor edits the app's plain environment variables: row edits PATCH single keys, the all-rows
// mode replaces the complete map (PUT); both send the read's etag and reload on a 412 conflict:
// a Key / Value table with Add, per-row edit and delete, plus Export .env, Import .env and an
// "edit all" mode with one Key / Value row per variable. canWrite false (role lacks
// app.env.write) shows the variables read-only.
export function EnvEditor({ org, app, canWrite = true }: { org: string; app: string; canWrite?: boolean }) {
  const env = useEnv(org, app);
  const save = useSaveEnv(org, app);
  const patch = usePatchEnv(org, app);
  const busy = save.isPending || patch.isPending;
  const { t } = useTranslation(["env", "common"]);
  const [mode, setMode] = useState<"table" | "rows">("table");
  const [rows, setRows] = useState<KvRow[]>([]);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Reset the all-rows draft whenever fresh data arrives (adjusting state during render, not in an effect).
  const [syncedData, setSyncedData] = useState<typeof env.data>(undefined);
  if (env.data && env.data !== syncedData) {
    setSyncedData(env.data);
    setRows(Object.keys(env.data.env).sort().map((k) => ({ key: k, value: env.data.env[k] })));
    setRowErrors({});
  }

  if (env.isError && env.error instanceof ApiError && env.error.status === 403) {
    // Env values are readable from the developer role up; viewers get a notice, not the values.
    return (
      <SectionCard title={t("editor.title")} description={t("editor.description")}>
        <div role="note" className="flex items-start gap-3 text-sm">
          <Lock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
          <div>
            <p className="font-medium">{t("denied.title")}</p>
            <p className="text-muted">{t("denied.description")}</p>
          </div>
        </div>
      </SectionCard>
    );
  }
  if (env.isError) {
    return <QueryError error={env.error} onRetry={() => void env.refetch()} notFoundTitle={t("appNotFound")} />;
  }
  if (env.isPending) return <Skeleton className="h-40 w-full" />;

  const { env: data, etag } = env.data;
  const keys = Object.keys(data).sort();

  function onSubmitRows(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const built = objectFromRows(
      rows,
      { keyRequired: t("rows.keyRequired"), valueRequired: t("rows.valueRequired"), duplicateKey: t("rows.duplicateKey") },
      { typed: false, allowEmpty: true },
    );
    const bad: Record<number, string> = {};
    rows.forEach((r, i) => {
      if (r.key.trim() !== "" && !KEY_PATTERN.test(r.key.trim())) bad[i] = t("keyInvalid");
    });
    const found = "errors" in built ? { ...built.errors, ...bad } : bad;
    if (Object.keys(found).length > 0) {
      setRowErrors(found);
      return;
    }
    if (!("value" in built)) return;
    setRowErrors({});
    save.mutate({ env: built.value as Record<string, string>, etag }, { onSuccess: () => setMode("table") });
  }

  function onSubmitRow(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing) return;
    const key = editing.key.trim();
    if (!KEY_PATTERN.test(key)) {
      setError(t("keyInvalid"));
      return;
    }
    setError(null);
    patch.mutate({ set: { [key]: editing.value }, etag }, { onSuccess: () => setEditing(null) });
  }

  function onImport(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseEnvText(String(reader.result ?? ""));
      if ("error" in parsed) {
        toast.error(t("toast.importFailed", { error: parsed.error }));
        return;
      }
      patch.mutate({ set: parsed.env, etag });
    };
    reader.readAsText(file);
  }

  const columns: DataColumn<string>[] = [
    {
      key: "key",
      header: t("columns.key"),
      primary: true,
      sortValue: (k) => k,
      cell: (k) => (
        <span className="inline-flex max-w-full items-center gap-1 font-mono text-[13px] font-medium">
          <span className="truncate" title={k}>
            {k}
          </span>
          <CopyButton text={k} label={t("copyLabel", { name: k })} />
        </span>
      ),
    },
    {
      key: "value",
      header: t("columns.value"),
      cell: (k) => {
        const shown = revealed[k] === true;
        return (
          <span className="inline-flex max-w-full items-center gap-1 font-mono text-[13px]">
            <span className="truncate text-muted">{shown ? data[k] : "••••••••"}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={shown ? t("hideValue", { name: k }) : t("showValue", { name: k })}
              onClick={() => setRevealed((r) => ({ ...r, [k]: !shown }))}
            >
              {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </Button>
          </span>
        );
      },
    },
    ...(canWrite
      ? [
          {
            key: "actions",
            header: t("common:actions"),
            align: "right" as const,
            cell: (k: string) => (
              <span className="inline-flex gap-0.5">
                <Button variant="ghost" size="icon-sm" aria-label={t("editLabel", { name: k })} onClick={() => setEditing({ key: k, value: data[k] })}>
                  <Pencil aria-hidden="true" />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label={t("deleteLabel", { name: k })} className="hover:bg-danger-soft hover:text-danger-text" onClick={() => setDeleting(k)}>
                  <Trash2 aria-hidden="true" />
                </Button>
              </span>
            ),
          },
        ]
      : []),
  ];

  const actions = (
    <>
      <button type="button" className={SMALL_CONTROL} onClick={() => downloadText(`${app}.env`, toEnvText(data))} disabled={keys.length === 0}>
        <Download aria-hidden="true" /> {t("export")}
      </button>
      {canWrite ? (
        <>
          <button type="button" className={SMALL_CONTROL} onClick={() => fileRef.current?.click()}>
            <Upload aria-hidden="true" /> {t("import")}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".env,text/plain"
            className="sr-only"
            aria-label={t("importFile")}
            onChange={(e) => {
              onImport(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className={SMALL_CONTROL}
            aria-pressed={mode === "rows"}
            onClick={() => {
              setError(null);
              setMode(mode === "rows" ? "table" : "rows");
            }}
          >
            <FileText aria-hidden="true" /> {mode === "rows" ? t("table") : t("editAll")}
          </button>
          <Button variant="default" size="sm" onClick={() => setEditing({ key: "", value: "" })}>
            <Plus aria-hidden="true" /> {t("common:add")}
          </Button>
        </>
      ) : null}
    </>
  );

  return (
    <SectionCard
      title={t("editor.title")}
      description={t("editor.description")}
      actions={actions}
      flush
    >
      {mode === "rows" ? (
        <form onSubmit={onSubmitRows} className="flex flex-col gap-3 p-5" aria-labelledby="env-heading">
          <KeyValueRows
            idPrefix="env-row"
            rows={rows}
            onChange={setRows}
            errors={rowErrors}
            disabled={!canWrite || save.isPending}
            labels={{
              key: t("dialog.key"),
              value: t("dialog.value"),
              add: t("rows.add"),
              remove: (key) => t("deleteLabel", { name: key }),
              keyPlaceholder: "DATABASE_URL",
            }}
          />
          <div className="flex gap-2">
            <Button type="submit" variant="default" disabled={save.isPending || !canWrite}>
              {t("rows.save")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setMode("table")}>
              {t("common:cancel")}
            </Button>
          </div>
        </form>
      ) : keys.length === 0 ? (
        <EmptyState
          bare
          entity="env"
          title={t("empty.title")}
          description={t("empty.description")}
          action={
            canWrite ? (
              <Button variant="default" onClick={() => setEditing({ key: "", value: "" })}>
                <Plus aria-hidden="true" /> {t("addVariable")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <DataTable
          className="px-5 pb-5"
          label={t("editor.title")}
          columns={columns}
          rows={keys}
          rowKey={(k) => k}
          count={t("count", { count: keys.length })}
        />
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <form onSubmit={onSubmitRow} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{editing && editing.key in data ? t("dialog.edit", { name: editing.key }) : t("addVariable")}</DialogTitle>
              <DialogDescription>{t("dialog.description")}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="env-key">{t("dialog.key")}</Label>
              <Input
                id="env-key"
                value={editing?.key ?? ""}
                onChange={(e) => setEditing((v) => (v ? { ...v, key: e.target.value } : v))}
                placeholder="DATABASE_URL"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "env-row-error" : undefined}
              />
              {error ? (
                <p id="env-row-error" role="alert" className="text-[13px] text-danger-text">
                  {error}
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="env-value">{t("dialog.value")}</Label>
              <Input
                id="env-value"
                value={editing?.value ?? ""}
                onChange={(e) => setEditing((v) => (v ? { ...v, value: e.target.value } : v))}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                {t("common:cancel")}
              </Button>
              <Button type="submit" variant="default" disabled={busy}>
                {t("dialog.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("confirm.title", { name: deleting ?? "" })}
        description={<p>{t("confirm.description")}</p>}
        confirmLabel={t("confirm.button")}
        pending={busy}
        onConfirm={() => {
          if (!deleting) return;
          patch.mutate({ unset: [deleting], etag }, { onSuccess: () => setDeleting(null) });
        }}
      />
    </SectionCard>
  );
}
