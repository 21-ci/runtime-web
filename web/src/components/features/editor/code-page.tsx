import { Link } from "@tanstack/react-router";
import { Loader2, RotateCw, Save } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { QueryError } from "@/components/features/empty/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";

import { useAppView, useCanDeploy, useFiles, useSaveFiles, useVersionState, type BuildDetails, type Diagnostic, type Files } from "./hooks";

// CodeMirror and the TS worker live in this lazy chunk only.
const CodeEditor = lazy(() => import("./cm-editor"));

// base: the loaded files the draft is built on. saved: the last snapshot saved from this draft
// (the dirty baseline until the files query reloads).
type Draft = { base: Files; files: Record<string, string>; saved?: Record<string, string> };

export function CodePage({ org, app }: { org: string; app: string }) {
  const view = useAppView(org, app);
  const files = useFiles(org, app);
  const canDeploy = useCanDeploy(org, view.data?.project);
  const save = useSaveFiles(org, app);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const [failure, setFailure] = useState<BuildDetails | null>(null);
  const [staleOpen, setStaleOpen] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const version = useVersionState(org, app, savedVersion);

  const data = files.data;
  const own = !!draft && draft.base === data;
  const current = data ? (own ? draft.files : data.files) : null;
  const baseline = own && draft.saved ? draft.saved : data?.files;
  const dirty = !!data && current !== baseline;
  const readOnly = !data || data.read_only || data.kind === "wasm" || canDeploy !== true;
  const path = data ? (active && current && active in current ? active : data.entry) : "";

  const doSave = useCallback(
    async (etag?: string) => {
      if (!data || !current || readOnly || save.isPending) return;
      const tag = etag ?? view.data?.etag;
      if (!tag) return;
      setFailure(null);
      try {
        const res = await save.mutateAsync({ entry: data.entry, files: current, etag: tag });
        // Only move the dirty baseline; keep edits typed while the save was in flight.
        setDraft((d) => ({ base: data, files: d && d.base === data ? d.files : current, saved: current }));
        setSavedVersion(res.version.version);
        setPreviewKey((k) => k + 1);
        toast.success(`Saved version ${res.version.version}`);
      } catch (err) {
        if (err instanceof ApiError && err.code === "stale") setStaleOpen(true);
        else if (err instanceof ApiError && err.status === 422) {
          const d = (err.details ?? {}) as Partial<BuildDetails>;
          setFailure({ reason: d.reason ?? err.code, message: d.message ?? err.message, diagnostics: d.diagnostics, version: d.version });
        } else toast.error(err instanceof Error ? err.message : "Save failed");
      }
    },
    [data, current, readOnly, save, view.data?.etag],
  );

  const saveRef = useRef(doSave);
  useEffect(() => {
    saveRef.current = doSave;
  });

  // ⌘S / Ctrl+S anywhere on the page. The editor handles it itself when focused (defaultPrevented).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && !e.defaultPrevented) {
        e.preventDefault();
        void saveRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const getFiles = useCallback(() => current ?? {}, [current]);
  const onChange = useCallback(
    (text: string) => {
      if (!data || !current || current[path] === text) return;
      setDraft((d) => ({ ...(d && d.base === data ? d : {}), base: data, files: { ...current, [path]: text } }));
    },
    [data, current, path],
  );

  if (view.isError || files.isError) {
    return (
      <QueryError
        error={view.error ?? files.error}
        onRetry={() => {
          void view.refetch();
          void files.refetch();
        }}
        notFoundTitle="App not found"
        notFoundDescription="It may have been deleted or you lack access."
      />
    );
  }
  if (!view.data || !data || !current) return <Skeleton className="h-96 w-full" />;

  const wasm = data.kind === "wasm";
  const diagnostics = failure?.diagnostics ?? [];
  const fileDiags = diagnostics.filter((d) => !d.file || d.file === path);
  const paths = Object.keys(current).sort();

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold">{view.data.name ?? view.data.slug}: code</h1>
        <StatusPill org={org} app={app} pending={save.isPending} version={savedVersion} state={version.data?.build_state} />
        {!readOnly && (
          <Button variant="default" onClick={() => void doSave()} disabled={save.isPending} aria-keyshortcuts="Meta+S Control+S">
            {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
            Save{dirty ? " *" : ""}
          </Button>
        )}
      </header>

      {wasm ? (
        <p role="note" className="rounded-md border border-line bg-panel-2 p-3 text-sm">
          This version is a WebAssembly component. Its source is not editable here; deploy a new build from your toolchain.
        </p>
      ) : readOnly ? (
        <p role="note" className="text-sm text-muted">
          {canDeploy === false ? "You have read-only access to this app's code." : "This version is read-only."}
        </p>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2">
          {paths.length > 1 && (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted">File</span>
              <select
                className="h-8 rounded-md border border-line bg-panel px-2"
                value={path}
                onChange={(e) => setActive(e.target.value)}
              >
                {paths.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          )}
          {wasm ? null : (
            <div className="h-[60vh]">
              <Suspense fallback={<Skeleton className="h-full w-full" />}>
                <CodeEditor
                  path={path}
                  value={current[path] ?? ""}
                  readOnly={readOnly}
                  onChange={onChange}
                  onSave={() => void saveRef.current()}
                  diagnostics={fileDiags}
                  getFiles={getFiles}
                />
              </Suspense>
            </div>
          )}
          {failure && <Problems failure={failure} />}
        </div>

        <section aria-label="Preview" className="flex min-h-[320px] flex-col gap-1">
          <div className="flex items-center gap-2 text-sm">
            <a href={view.data.url} target="_blank" rel="noreferrer" className="truncate text-muted hover:underline">
              {view.data.url}
            </a>
            <Button size="icon" variant="ghost" className="ml-auto" aria-label="Reload preview" onClick={() => setPreviewKey((k) => k + 1)}>
              <RotateCw aria-hidden />
            </Button>
          </div>
          <iframe
            key={previewKey}
            title="App preview"
            src={view.data.url}
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
            className="h-[60vh] w-full rounded-md border border-line bg-white"
          />
        </section>
      </div>

      <Dialog open={staleOpen} onOpenChange={setStaleOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Code changed elsewhere</DialogTitle>
            <DialogDescription>
              Someone saved this app after you opened it. Reload to get their version (your edits are discarded), or
              overwrite it with yours.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => {
                setStaleOpen(false);
                setDraft(null);
                void view.refetch();
                void files.refetch();
              }}
            >
              Reload
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                setStaleOpen(false);
                const fresh = await view.refetch();
                if (fresh.data) void doSave(fresh.data.etag);
              }}
            >
              Overwrite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusPill(props: { org: string; app: string; pending: boolean; version: number | null; state?: string }) {
  const { org, app, pending, version, state } = props;
  if (pending || state === "pending" || state === "building") {
    return (
      <Badge variant="info" role="status">
        <Loader2 className="size-3 animate-spin" aria-hidden /> Building
      </Badge>
    );
  }
  if (version === null) return null;
  if (state === "failed") {
    return (
      <Link to="/$org/apps/$app/versions" params={{ org, app }} role="status">
        <Badge variant="danger">Build failed v{version}</Badge>
      </Link>
    );
  }
  return (
    <Link to="/$org/apps/$app/versions" params={{ org, app }} aria-label={`Live v${version}, open versions`}>
      <Badge variant="success">Live v{version}</Badge>
    </Link>
  );
}

function Problems({ failure }: { failure: BuildDetails }) {
  const diags: Diagnostic[] = failure.diagnostics ?? [];
  return (
    <div role="alert" className="rounded-md border border-danger bg-danger-soft p-3 text-sm text-danger-text">
      <p className="font-semibold">
        Build failed{failure.version ? ` (version ${failure.version})` : ""}: {failure.message}. The live version is unchanged.
      </p>
      {diags.length > 0 && (
        <ul aria-label="Build problems" className="mt-2 flex flex-col gap-1 font-mono text-xs">
          {diags.map((d, i) => (
            <li key={i}>
              <span className="font-semibold">
                {[d.file, d.line, d.column].filter((x) => x !== undefined).join(":")}
              </span>{" "}
              {d.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
