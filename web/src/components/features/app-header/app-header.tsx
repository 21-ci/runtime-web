import { Link } from "@tanstack/react-router";

import { Badge } from "@/components/ui/badge";
import type { AppSummary } from "@/hooks/orgs";

const PILL: Record<string, "default" | "success" | "danger" | "info"> = {
  ready: "success",
  failed: "danger",
  building: "info",
  pending: "info",
};

const APP_TABS = [
  { to: "/$org/apps/$app", label: "Overview", exact: true },
  { to: "/$org/apps/$app/code", label: "Code", exact: false },
  { to: "/$org/apps/$app/logs", label: "Logs", exact: false },
  { to: "/$org/apps/$app/versions", label: "Versions", exact: false },
  { to: "/$org/apps/$app/triggers", label: "Triggers", exact: false },
  { to: "/$org/apps/$app/settings", label: "Settings", exact: false },
] as const;

// AppHeader shows the app name, its project and environment, the build status pill and the
// last build or runtime error. The tabs link to the app sub-pages.
export function AppHeader({ org, app }: { org: string; app: AppSummary }) {
  const { build_state, tier, last_error } = app.status;
  return (
    <header className="flex flex-col gap-2">
      <p className="text-sm text-muted">
        <Link to="/$org/projects/$p" params={{ org, p: app.project }} className="hover:underline">
          {app.project}
        </Link>
        {" / "}
        {app.environment}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{app.name ?? app.slug}</h1>
        <Badge variant={PILL[build_state] ?? "default"} title={`Tier ${tier}`}>
          {build_state}
        </Badge>
      </div>
      {last_error ? (
        <p role="note" className="text-sm text-danger-text">
          Last error: {last_error}
        </p>
      ) : null}
      <nav aria-label="App sections" className="flex gap-1 overflow-x-auto border-b border-line">
        {APP_TABS.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            params={{ org, app: app.slug }}
            activeOptions={{ exact: t.exact }}
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-semibold text-muted hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
            activeProps={{ className: "border-blue text-text", "aria-current": "page" }}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
