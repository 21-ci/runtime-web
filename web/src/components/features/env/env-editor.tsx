import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Eye, EyeOff, FileText, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { QueryError } from "@/components/features/empty/query-error";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard, SMALL_CONTROL } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CopyButton } from "@/components/ui/url-bar";
import { api } from "@/lib/api";

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
    if (!KEY_PATTERN.test(key)) return { error: `Line ${i + 1}: use KEY=VALUE with a valid name.` };
    env[key] = line.slice(eq + 1);
  }
  return { env };
}

export function useEnv(org: string, app: string) {
  return useQuery({
    queryKey: ["env", org, app],
    queryFn: () => api.get<{ env: Record<string, string> }>(`${appPath(org, app)}/env`).then((r) => r.env),
  });
}

export function useSaveEnv(org: string, app: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, string>) =>
      api.put<{ env: Record<string, string> }>(`${appPath(org, app)}/env`, { env: body }),
    onSuccess: () => {
      toast.success("Environment saved.");
      void qc.invalidateQueries({ queryKey: ["env", org, app] });
    },
  });
}

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// EnvEditor edits the app's plain environment variables as one complete map (PUT replaces it):
// a Key / Value table with Add, per-row edit and delete, plus Export .env, Import .env and a raw
// ".env" text mode. canWrite false (role lacks app.env.write) shows the variables read-only.
export function EnvEditor({ org, app, canWrite = true }: { org: string; app: string; canWrite?: boolean }) {
  const env = useEnv(org, app);
  const save = useSaveEnv(org, app);
  const [mode, setMode] = useState<"table" | "text">("table");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (env.data) setText(toEnvText(env.data));
  }, [env.data]);

  if (env.isError) {
    return <QueryError error={env.error} onRetry={() => void env.refetch()} notFoundTitle="App not found" />;
  }
  if (env.isPending) return <Skeleton className="h-40 w-full" />;

  const data = env.data;
  const keys = Object.keys(data).sort();

  function onSubmitText(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = parseEnvText(text);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    save.mutate(parsed.env, { onSuccess: () => setMode("table") });
  }

  function onSubmitRow(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing) return;
    const key = editing.key.trim();
    if (!KEY_PATTERN.test(key)) {
      setError("Use letters, digits and underscores, starting with a letter or underscore.");
      return;
    }
    setError(null);
    save.mutate({ ...data, [key]: editing.value }, { onSuccess: () => setEditing(null) });
  }

  function onImport(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseEnvText(String(reader.result ?? ""));
      if ("error" in parsed) {
        toast.error(`Could not import: ${parsed.error}`);
        return;
      }
      save.mutate({ ...data, ...parsed.env });
    };
    reader.readAsText(file);
  }

  const actions = (
    <>
      <button type="button" className={SMALL_CONTROL} onClick={() => downloadText(`${app}.env`, toEnvText(data))} disabled={keys.length === 0}>
        <Download aria-hidden="true" /> Export .env
      </button>
      {canWrite ? (
        <>
          <button type="button" className={SMALL_CONTROL} onClick={() => fileRef.current?.click()}>
            <Upload aria-hidden="true" /> Import .env
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".env,text/plain"
            className="sr-only"
            aria-label="Import .env file"
            onChange={(e) => {
              onImport(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className={SMALL_CONTROL}
            aria-pressed={mode === "text"}
            onClick={() => {
              setError(null);
              setMode(mode === "text" ? "table" : "text");
            }}
          >
            <FileText aria-hidden="true" /> {mode === "text" ? "Table" : "Edit as .env"}
          </button>
          <Button variant="default" size="sm" onClick={() => setEditing({ key: "", value: "" })}>
            <Plus aria-hidden="true" /> Add
          </Button>
        </>
      ) : null}
    </>
  );

  return (
    <SectionCard
      title="Environment variables"
      description="Plain configuration your app reads at run time. Use secrets for anything sensitive."
      actions={actions}
      flush
    >
      {mode === "text" ? (
        <form onSubmit={onSubmitText} className="flex flex-col gap-3 p-5" aria-labelledby="env-heading">
          <label htmlFor="env-text" className="sr-only">
            Environment variables
          </label>
          <Textarea
            id="env-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            readOnly={!canWrite}
            spellCheck={false}
            rows={10}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "env-error" : undefined}
            autoComplete="off"
            className="font-mono text-[13px]"
          />
          {error ? (
            <p id="env-error" role="alert" className="text-[13px] text-danger-text">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" variant="default" disabled={save.isPending}>
              Save variables
            </Button>
            <Button type="button" variant="ghost" onClick={() => setMode("table")}>
              Cancel
            </Button>
          </div>
        </form>
      ) : keys.length === 0 ? (
        <EmptyState
          bare
          entity="env"
          title="No environment variables"
          description="Add a KEY=VALUE pair or import a .env file."
          action={
            canWrite ? (
              <Button variant="default" onClick={() => setEditing({ key: "", value: "" })}>
                <Plus aria-hidden="true" /> Add variable
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Table bare>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Value</TableHead>
              <TableHead className="w-28 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((k) => {
              const shown = revealed[k] === true;
              return (
                <TableRow key={k}>
                  <TableCell className="font-mono text-[13px] font-medium">
                    <span className="inline-flex items-center gap-1">
                      {k}
                      <CopyButton text={k} label={`Copy ${k}`} />
                    </span>
                  </TableCell>
                  <TableCell className="max-w-[320px] font-mono text-[13px]">
                    <span className="inline-flex max-w-full items-center gap-1">
                      <span className="truncate text-muted">{shown ? data[k] : "••••••••"}</span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={shown ? `Hide value of ${k}` : `Show value of ${k}`}
                        onClick={() => setRevealed((r) => ({ ...r, [k]: !shown }))}
                      >
                        {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                      </Button>
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    {canWrite ? (
                      <span className="inline-flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${k}`} onClick={() => setEditing({ key: k, value: data[k] })}>
                          <Pencil aria-hidden="true" />
                        </Button>
                        <Button variant="ghost" size="icon-sm" aria-label={`Delete ${k}`} className="hover:bg-danger-soft hover:text-danger-text" onClick={() => setDeleting(k)}>
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </span>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <form onSubmit={onSubmitRow} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{editing && editing.key in data ? `Edit ${editing.key}` : "Add variable"}</DialogTitle>
              <DialogDescription>Saving replaces the whole set of variables for this app.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="env-key">Key</Label>
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
              <Label htmlFor="env-value">Value</Label>
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
                Cancel
              </Button>
              <Button type="submit" variant="default" disabled={save.isPending}>
                Save variable
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting ?? ""}?`}
        description={<p>Apps that read this variable see it missing after the next request.</p>}
        confirmLabel="Delete variable"
        pending={save.isPending}
        onConfirm={() => {
          if (!deleting) return;
          const next = { ...data };
          delete next[deleting];
          save.mutate(next, { onSuccess: () => setDeleting(null) });
        }}
      />
    </SectionCard>
  );
}
