import { Boxes as BoxesTile } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { IconTile } from "@/components/ui/icon-tile";
import { Link, useLocation } from "@tanstack/react-router";

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
  const location = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  // Fade only the edges that have tabs hidden beyond them.
  function measure() {
    const nav = navRef.current;
    if (!nav) return;
    const start = nav.scrollLeft > 1;
    const end = nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }

  // Keep the active tab on screen on narrow widths; the tab bar scrolls, the page does not.
  useEffect(() => {
    measure();
    const active = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    active?.scrollIntoView({ inline: "center", block: "nearest", behavior: "auto" });
  }, [location.pathname]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const fade = edges.start || edges.end ? fadeMask(edges) : undefined;

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
        <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-[-0.01em]"><IconTile icon={BoxesTile} entity="apps" size="md" />{app.name ?? app.slug}</h1>
        <Badge variant={PILL[build_state] ?? "default"} title={`Tier ${tier}`}>
          {build_state}
        </Badge>
      </div>
      {last_error ? (
        <p role="note" className="text-sm text-danger-text">
          Last error: {last_error}
        </p>
      ) : null}
      <div className="relative -mx-3 md:mx-0">
        <nav
          ref={navRef}
          aria-label="App sections"
          onScroll={measure}
          style={fade}
          className="flex snap-x snap-mandatory scroll-px-3 gap-1 overflow-x-auto border-b border-line px-3 md:px-0 [scrollbar-width:none]"
        >
          {APP_TABS.map((t) => (
            <Link
              key={t.to}
              to={t.to}
              params={{ org, app: app.slug }}
              activeOptions={{ exact: t.exact }}
              className="-mb-px flex h-9 shrink-0 snap-start items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
              activeProps={{ className: "border-text text-text", "aria-current": "page" }}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}

// fadeMask fades the tab bar edges that have more tabs beyond them (a CSS mask, so no overlay).
function fadeMask({ start, end }: { start: boolean; end: boolean }): CSSProperties {
  const left = start ? "transparent, #000 32px" : "#000, #000";
  const right = end ? "#000 calc(100% - 32px), transparent" : "#000, #000";
  const mask = `linear-gradient(to right, ${left}, ${right})`;
  return { maskImage: mask, WebkitMaskImage: mask };
}
