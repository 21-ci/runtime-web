import { Download } from "lucide-react";

import { useAppView, appPath } from "@/components/features/app-header/hooks";
import { QueryError } from "@/components/features/empty/query-error";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjects } from "@/hooks/orgs";

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
  const shown = key === "error_rate" ? (value * 100).toFixed(1) : String(value);
  return `${shown}${suffix ?? ""}`;
}

// OverviewPage is the app's landing tab: stats for the last five minutes, the events panel and the
// data export (project admins and org owners or admins only; the project role says which).
export function OverviewPage({ org, app }: { org: string; app: string }) {
  const view = useAppView(org, app);
  const stats = useAppStats(org, app, "5m");
  const projects = useProjects(org);

  if (view.isError) {
    return <QueryError error={view.error} onRetry={() => void view.refetch()} notFoundTitle="App not found" />;
  }
  if (view.isPending) return <Skeleton className="h-40 w-full" />;

  const role = projects.data?.find((p) => p.slug === view.data.project)?.role;
  const canExport = role === "admin";

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="stats-heading" className="flex flex-col gap-2">
        <h2 id="stats-heading" className="text-base font-semibold">
          Last 5 minutes
        </h2>
        {stats.isError ? (
          <QueryError error={stats.error} onRetry={() => void stats.refetch()} notFoundTitle="Stats not found" />
        ) : stats.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {TILES.map((t) => (
              <div key={t.key} className="rounded-[10px] border border-line bg-surface p-3">
                <dt className="text-xs text-muted">{t.label}</dt>
                <dd className="text-lg font-semibold">{formatTile(t.key, stats.data[t.key], t.suffix)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <EventsPanel org={org} app={app} />

      {canExport ? (
        <section aria-labelledby="export-heading" className="flex flex-col gap-2">
          <h2 id="export-heading" className="text-base font-semibold">
            Data
          </h2>
          <p className="text-sm text-muted">Download the app's SQLite database.</p>
          <Button asChild variant="secondary" className="self-start">
            <a href={`/api${appPath(org, app)}/export`} download>
              <Download aria-hidden="true" />
              Export data
            </a>
          </Button>
        </section>
      ) : null}
    </div>
  );
}
