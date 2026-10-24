import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, FileCode2, Loader2, PanelRight, Save, ScrollText } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { QueryError } from "@/components/features/empty/query-error";
import { LogsView } from "@/components/features/logs/logs-view";
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
import { Kbd } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PreviewFrame } from "@/components/ui/preview-frame";
import { UrlBar } from "@/components/ui/url-bar";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

import { useAppView, useCanDeploy, useFiles, useSaveFiles, useVersionState, type BuildDetails, type Diagnostic, type Files } from "./hooks";

// CodeMirror and the TS worker live in this lazy chunk only.
const CodeEditor = lazy(() => import("./cm-editor"));

// base: the loaded files the draft is built on. saved: the last snapshot saved from this draft
// (the dirty baseline until the files query reloads).
type Draft = { base: Files; files: Record<string, string>; saved?: Record<string, string> };

const PREVIEW_KEY = "rt-code-preview";
const LOGS_KEY = "rt-code-logs";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    // Storage blocked: the choice still applies for this page view.
  }
}

// CodePage is the val.town-style editor: a toolbar, the file list, the editor, a collapsible
// preview pane on the right and a logs dock at the bottom.
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
  const [previewOpen, setPreviewOpen] = useState(() => readFlag(PREVIEW_KEY, true));
  const [logsOpen, setLogsOpen] = useState(() => readFlag(LOGS_KEY, false));
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

  function togglePreview() {
    setPreviewOpen((v) => {
      writeFlag(PREVIEW_KEY, !v);
      return !v;
    });
  }
  function toggleLogs() {
    setLogsOpen((v) => {
      writeFlag(LOGS_KEY, !v);
      return !v;
    });
  }

  if (view.isError || files.isError) {
    return (
      <div className="p-6">
        <QueryError
          error={view.error ?? files.error}
          onRetry={() => {
            void view.refetch();
            void files.refetch();
          }}
          notFoundTitle="App not found"
          notFoundDescription="It may have been deleted or you lack access."
        />
      </div>
    );
  }
  if (!view.data || !data || !current) {
    return (
      <div className="flex flex-col gap-3 p-4" aria-busy="true">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    );
  }

  const wasm = data.kind === "wasm";
  const diagnostics = failure?.diagnostics ?? [];
  const fileDiags = diagnostics.filter((d) => !d.file || d.file === path);
  const paths = Object.keys(current).sort();

  return (
    <div className="flex min-h-0 flex-1 flex-col md:h-[calc(100dvh-48px)]">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-bg px-3">
        <p className="flex min-w-0 items-center gap-1.5 text-sm">
          <span className="hidden text-muted sm:inline">Code</span>
          <span className="hidden text-muted/60 sm:inline">/</span>
          <span className="truncate font-medium">{path}</span>
          {dirty ? <span className="text-muted" aria-hidden="true">•</span> : null}
        </p>
        <div className="ml-auto flex items-center gap-1.5">
          <StatusPill org={org} app={app} pending={save.isPending} version={savedVersion} state={version.data?.build_state} />
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={previewOpen}
            onClick={togglePreview}
            className="hidden lg:inline-flex"
            title="Show or hide the response pane"
          >
            <PanelRight aria-hidden="true" /> Preview
          </Button>
          {!readOnly && (
            <Button variant="default" size="sm" onClick={() => void doSave()} disabled={save.isPending} aria-keyshortcuts="Meta+S Control+S">
              {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
              Save{dirty ? " *" : ""}
              <Kbd className="hidden bg-transparent text-on-primary/80 md:inline">⌘S</Kbd>
            </Button>
          )}
        </div>
      </header>

      {wasm ? (
        <p role="note" className="border-b border-line bg-panel px-4 py-2 text-sm">
          This version is a WebAssembly component. Its source is not editable here; deploy a new build from your toolchain.
        </p>
      ) : readOnly ? (
        <p role="note" className="border-b border-line bg-panel px-4 py-1.5 text-[13px] text-muted">
          {canDeploy === false ? "You have read-only access to this app's code." : "This version is read-only."}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="hidden w-52 shrink-0 flex-col border-r border-line bg-panel md:flex" aria-label="Files">
          <p className="px-3 pb-1 pt-3 text-[11px] font-semibold text-muted">Files</p>
          <ul className="flex flex-col gap-px px-2">
            {paths.map((p) => (
              <li key={p}>
                <button
                  type="button"
                  onClick={() => setActive(p)}
                  aria-current={p === path ? "true" : undefined}
                  className={cn(
                    "flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus",
                    p === path ? "bg-active font-medium text-text" : "text-muted hover:text-text",
                  )}
                >
                  <FileCode2 className="size-3.5 shrink-0 text-tag-blue-text" aria-hidden="true" />
                  <span className="truncate">{p}</span>
                  {p === data.entry ? <span className="ml-auto text-[10px] uppercase tracking-wide text-muted">entry</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {paths.length > 1 && (
            <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-sm md:hidden">
              <span className="text-muted">File</span>
              <Select value={path} onValueChange={setActive}>
                <SelectTrigger aria-label="File" className="h-8 w-auto min-w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {paths.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {wasm ? null : (
            <div className="min-h-[50vh] flex-1 md:min-h-0">
              <Suspense fallback={<Skeleton className="h-full w-full rounded-none" />}>
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

        <section
          aria-label="Preview"
          className={cn(
            "flex min-h-[320px] flex-col gap-2 border-t border-line bg-panel p-2 md:min-h-0 lg:w-[42%] lg:border-l lg:border-t-0",
            !previewOpen && "lg:hidden",
          )}
        >
          <UrlBar url={view.data.url} badge={<Badge variant="success">HTTP</Badge>} onReload={() => setPreviewKey((k) => k + 1)} className="bg-surface" />
          <PreviewFrame url={view.data.url} title="App preview" reloadKey={previewKey} className="min-h-[260px] flex-1 shadow-none" />
        </section>
      </div>

      <section aria-label="Logs dock" className="shrink-0 border-t border-line bg-panel">
        <button
          type="button"
          onClick={toggleLogs}
          aria-expanded={logsOpen}
          className="flex h-9 w-full items-center gap-2 px-3 text-[13px] font-medium text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
        >
          <ScrollText className="size-4" aria-hidden="true" />
          Logs
          {logsOpen ? <ChevronDown className="ml-auto size-4" aria-hidden="true" /> : <ChevronUp className="ml-auto size-4" aria-hidden="true" />}
        </button>
        {logsOpen ? (
          <div className="h-64 border-t border-line">
            <LogsView org={org} app={app} compact />
          </div>
        ) : null}
      </section>

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
              variant="danger-solid"
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
      <Badge variant="warning" role="status">
        <Loader2 className="animate-spin" aria-hidden /> Building
      </Badge>
    );
  }
  if (version === null) return null;
  if (state === "failed") {
    return (
      <Link to="/$org/apps/$app/versions" params={{ org, app }} role="status">
        <Badge variant="danger" dot>
          Build failed v{version}
        </Badge>
      </Link>
    );
  }
  return (
    <Link to="/$org/apps/$app/versions" params={{ org, app }} aria-label={`Live v${version}, open versions`}>
      <Badge variant="success" dot>
        Live v{version}
      </Badge>
    </Link>
  );
}

function Problems({ failure }: { failure: BuildDetails }) {
  const diags: Diagnostic[] = failure.diagnostics ?? [];
  return (
    <div role="alert" className="border-t border-danger/30 bg-danger-soft p-3 text-sm text-danger-text">
      <p className="font-semibold">
        Build failed{failure.version ? ` (version ${failure.version})` : ""}: {failure.message}. The live version is unchanged.
      </p>
      {diags.length > 0 && (
        <ul aria-label="Build problems" className="mt-2 flex flex-col gap-1 font-mono text-xs">
          {diags.map((d, i) => (
            <li key={i}>
              <span className="font-semibold">{[d.file, d.line, d.column].filter((x) => x !== undefined).join(":")}</span>{" "}
              {d.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
