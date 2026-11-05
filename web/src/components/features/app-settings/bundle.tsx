import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, getBlob, getCsrfToken } from "@/lib/api";
import { errorMessage } from "@/lib/error-message";

type BundleState = { id: string; state: string; bytes: number | null; failure: string | null; too_large?: boolean };
type ImportResult = { slug: string; warnings: unknown[]; missing_secrets: string[] };

const MAX_UPLOAD = 4 << 20;
const base = (org: string) => `/orgs/${encodeURIComponent(org)}/apps`;

// Bundles hold settings, env values, data and sources; secrets never travel and must be entered again. Large ones go
// through the CLI, whose commands are shown here, because the console's path to the node is capped.
export function BundleSection({ org, app, project, environment }: { org: string; app: string; project: string; environment: string }) {
  const { t } = useTranslation("platform");
  const [id, setId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => api.post<BundleState>(`${base(org)}/${encodeURIComponent(app)}/bundle`),
    onSuccess: (b) => setId(b.id),
  });
  const status = useQuery({
    queryKey: ["bundle", org, app, id],
    enabled: id !== null,
    queryFn: () => api.get<BundleState>(`${base(org)}/${encodeURIComponent(app)}/bundle/${encodeURIComponent(id ?? "")}`),
    refetchInterval: (q) => (q.state.data && q.state.data.state !== "running" ? false : 2000),
  });
  const s = status.data;

  async function download() {
    try {
      const blob = await getBlob(`${base(org)}/${encodeURIComponent(app)}/bundle/${encodeURIComponent(id ?? "")}/download`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `app-${app}.tar.zst`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5 shadow-card">
      <h3 className="text-[15px] font-semibold">{t("bundle.title")}</h3>
      <p className="text-sm text-muted">{t("bundle.description")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={start.isPending || s?.state === "running"} onClick={() => start.mutate()}>{t("bundle.start")}</Button>
        {s?.state === "running" ? <span className="text-sm text-muted" role="status">{t("bundle.running")}</span> : null}
        {s?.state === "failed" ? <span className="text-sm text-danger" role="alert">{t("bundle.failed", { code: s.failure ?? "internal" })}</span> : null}
        {s?.state === "ready" && !s.too_large ? <Button size="sm" onClick={() => void download()}>{t("bundle.download", { bytes: s.bytes ?? 0 })}</Button> : null}
        {s?.state === "ready" && s.too_large ? <span className="text-sm" role="status">{t("bundle.tooLarge")}</span> : null}
      </div>
      <ImportForm org={org} app={app} project={project} environment={environment} />
      <div className="text-sm">
        <p className="mb-1 font-medium">{t("bundle.cli")}</p>
        <pre className="overflow-x-auto rounded-md bg-panel-2 p-2 font-mono text-[13px]">{`21ci app export ${app} --out app-${app}.tar.zst\n21ci app import app-${app}.tar.zst --slug ${app}-copy`}</pre>
      </div>
    </div>
  );
}

function ImportForm({ org, app, project, environment }: { org: string; app: string; project: string; environment: string }) {
  const { t } = useTranslation("platform");
  const [slug, setSlug] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const run = useMutation({
    meta: { skipGlobalError: true },
    mutationFn: async (): Promise<ImportResult> => {
      const q = new URLSearchParams({ slug, project, environment });
      if (!file) {
        q.set("from", app);
        return api.post<ImportResult>(`${base(org)}/import?${q.toString()}`);
      }
      const csrf = getCsrfToken();
      const res = await fetch(`/api${base(org)}/import?${q.toString()}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/zstd", ...(csrf ? { "x-csrf-token": csrf } : {}) },
        body: file,
      });
      if (!res.ok) throw new Error(t("bundle.importFailed", { status: res.status }));
      return (await res.json()) as ImportResult;
    },
  });
  const tooBig = file !== null && file.size > MAX_UPLOAD;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!tooBig) run.mutate();
  };
  return (
    <form onSubmit={submit} className="flex max-w-md flex-col gap-2 border-t border-line pt-3">
      <p className="text-sm font-medium">{t("bundle.importTitle")}</p>
      <Label htmlFor="import-slug">{t("bundle.newSlug")}</Label>
      <Input id="import-slug" value={slug} required autoComplete="off" onChange={(e) => setSlug(e.target.value)} />
      <Label htmlFor="import-file">{t("bundle.file")}</Label>
      <input id="import-file" type="file" accept=".zst,.tar.zst" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <p className="text-xs text-muted">{t("bundle.fileHint", { app })}</p>
      {tooBig ? <p className="text-sm text-danger" role="alert">{t("bundle.fileTooLarge")}</p> : null}
      {run.isError ? <p className="text-sm text-danger" role="alert">{errorMessage(run.error)}</p> : null}
      {run.data ? (
        <p className="text-sm" role="status">
          {t("bundle.imported", { slug: run.data.slug })}
          {run.data.missing_secrets.length ? ` ${t("bundle.missingSecrets", { names: run.data.missing_secrets.join(", ") })}` : ""}
        </p>
      ) : null}
      <div><Button size="sm" type="submit" variant="secondary" disabled={run.isPending || tooBig}>{t(file ? "bundle.import" : "bundle.fork")}</Button></div>
    </form>
  );
}
