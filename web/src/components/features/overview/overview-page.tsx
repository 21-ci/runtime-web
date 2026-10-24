import { Link } from "@tanstack/react-router";
import { Code2, Download, ExternalLink, FileCode2, History } from "lucide-react";
import { useState } from "react";

import { useAppView, appPath } from "@/components/features/app-header/hooks";
import { useFiles } from "@/components/features/editor/hooks";
import { QueryError } from "@/components/features/empty/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LetterTile, hueFor } from "@/components/ui/icon-tile";
import { SectionCard, SMALL_CONTROL } from "@/components/ui/section-card";
import { StatTile } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { UrlBar } from "@/components/ui/url-bar";
import { useProjects } from "@/hooks/orgs";
import { formatCount } from "@/lib/format";

import { EventsPanel } from "./events-panel";
import { useAppStats, type AppStats } from "./hooks";

const TILES: { key: keyof AppStats; label: string; suffix?: string }[] = [
  { key: "requests", label: "Requests" },
  { key: "errors", label: "Errors" },
  { key: "error_rate", label: "Error rate", suffix: "%" },
  { key: "p50_ms", label: "p50", suffix: " ms" },
  { key: "p95_ms", label: "p95", suffix: " ms" },
  { key: "p99_ms", label: "p99", suffix: " ms" },
];

function formatTile(key: keyof AppStats, value: unknown, suffix?: string): string {
  if (typeof value !== "number") return "-";
  const shown = key === "error_rate" ? (value * 100).toFixed(1) : formatCount(value);
  return `${shown}${suffix ?? ""}`;
}

const ACCESS_LABEL = { public: "Public", key: "Key required", internal: "Internal" } as const;
const BUILD_VARIANT: Record<string, "success" | "danger" | "warning" | "default"> = {
  ready: "success",
  failed: "danger",
  building: "warning",
  pending: "warning",
};

// OverviewPage is the app's landing page (val.town model): identity, live URL with a response
// preview, the last five minutes of stats, the code files, runtime events and the data export
// (project admins only; the project role says which).
export function OverviewPage({ org, app }: { org: string; app: string }) {
  const view = useAppView(org, app);
  const stats = useAppStats(org, app, "5m");
  const files = useFiles(org, app);
  const projects = useProjects(org);
  const [previewKey, setPreviewKey] = useState(0);

  if (view.isError) {
    return <QueryError error={view.error} onRetry={() => void view.refetch()} notFoundTitle="App not found" />;
  }
  if (view.isPending) {
    return (
      <div className="flex flex-col gap-5" aria-busy="true">
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const a = view.data;
  const project = projects.data?.find((p) => p.slug === a.project);
  const canExport = project?.role === "admin";
  const name = a.name ?? a.slug;
  const build = a.status.build_state;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-4">
          <LetterTile label={name} hue={hueFor(a.slug)} size="xl" solid />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted">
              <Link to="/$org/projects/$p" params={{ org, p: a.project }} className="hover:underline">
                {project?.name ?? a.project}
              </Link>
              <span className="mx-1 text-muted/60">/</span>
              {a.environment}
            </p>
            <h1 className="truncate text-xl font-semibold tracking-[-0.01em] tracking-[-0.015em]">{name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge variant={BUILD_VARIANT[build] ?? "default"} dot>
                {build}
              </Badge>
              <Badge variant="blue">{ACCESS_LABEL[a.access] ?? a.access}</Badge>
              <Badge variant="default">{a.runtime === "wasm" ? "WebAssembly" : "HTTP"}</Badge>
              {a.live_version !== null ? <Badge variant="outline">v{a.live_version}</Badge> : null}
            </div>
          </div>
          <div className="flex basis-full flex-wrap items-center gap-2 sm:basis-auto">
            <Button asChild variant="secondary">
              <Link to="/$org/apps/$app/code" params={{ org, app }}>
                <Code2 aria-hidden="true" /> Edit code
              </Link>
            </Button>
            <Button asChild variant="default">
              <a href={a.url} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden="true" /> Open
              </a>
            </Button>
          </div>
        </div>
        {a.status.last_error ? (
          <p role="note" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger-text">
            Last error: {a.status.last_error}
          </p>
        ) : null}
      </header>

      <section aria-label="Live URL" className="flex flex-col gap-3">
        <UrlBar
          url={a.url}
          badge={<Badge variant="success">HTTP</Badge>}
          onReload={() => setPreviewKey((k) => k + 1)}
        />
        <iframe
          key={previewKey}
          title="Response preview"
          src={a.url}
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
          className="h-[320px] w-full rounded-lg border border-line bg-white shadow-card"
        />
      </section>

      <section aria-labelledby="stats-heading" className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h2 id="stats-heading" className="text-[15px] font-semibold">
            Last 5 minutes
          </h2>
          <Link to="/$org/apps/$app/logs" params={{ org, app }} className="text-[13px] text-muted hover:text-text hover:underline">
            View logs
          </Link>
        </div>
        {stats.isError ? (
          <QueryError error={stats.error} onRetry={() => void stats.refetch()} notFoundTitle="Stats not found" />
        ) : stats.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {TILES.map((t) => (
              <StatTile key={t.key} label={t.label} value={formatTile(t.key, stats.data[t.key], t.suffix)} />
            ))}
          </dl>
        )}
      </section>

      <SectionCard
        title="Code"
        flush
        actions={
          <Link to="/$org/apps/$app/versions" params={{ org, app }} className={SMALL_CONTROL}>
            <History aria-hidden="true" /> History
          </Link>
        }
      >
        {files.isPending ? (
          <div className="p-4" aria-busy="true">
            <Skeleton className="h-10 w-full" />
          </div>
        ) : files.isError || !files.data ? (
          <p className="px-5 py-4 text-sm text-muted">Code is not available for this version.</p>
        ) : (
          <ul className="divide-y divide-line">
            {Object.keys(files.data.files)
              .sort()
              .map((path) => (
                <li key={path}>
                  <Link
                    to="/$org/apps/$app/code"
                    params={{ org, app }}
                    className="flex h-11 items-center gap-3 px-5 text-sm outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    <FileCode2 className="size-4 shrink-0 text-tag-blue-text" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate font-medium">{path}</span>
                    {path === files.data?.entry ? <Badge variant="success">entry</Badge> : null}
                    <span className="hidden text-[12px] text-muted sm:inline">v{files.data?.version}</span>
                  </Link>
                </li>
              ))}
          </ul>
        )}
      </SectionCard>

      <EventsPanel org={org} app={app} />

      {canExport ? (
        <SectionCard title="Data" description="Download the app's SQLite database as a file.">
          <Button asChild variant="secondary" className="self-start">
            <a href={`/api${appPath(org, app)}/export`} download>
              <Download aria-hidden="true" />
              Export data
            </a>
          </Button>
        </SectionCard>
      ) : null}
    </div>
  );
}
