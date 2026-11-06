import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { APP_SECTIONS } from "@/components/layout/sidebar";
import { Badge } from "@/components/ui/badge";
import { EntityTile } from "@/components/ui/icon-tile";
import { Skeleton } from "@/components/ui/skeleton";
import { UrlBar } from "@/components/ui/url-bar";
import type { AppSummary } from "@/hooks/orgs";

import type { AppView } from "./hooks";

const STATE_VARIANT = { ready: "success", failed: "danger", building: "warning", pending: "warning" } as const;
type KnownState = keyof typeof STATE_VARIANT;
const isKnownState = (s: string): s is KnownState => s in STATE_VARIANT;

// AppHeader names the app on every app page: tile, name, state, access, live version and URL. It holds its
// height while the app loads, so the page below does not jump.
export function AppHeader({ org, slug, app, view }: { org: string; slug: string; app?: AppSummary | undefined; view?: AppView | undefined }) {
  const { t } = useTranslation("app-header");
  const state = app?.status.build_state;
  return (
    <div data-testid="app-header" className="flex flex-col gap-3 px-4 pt-4 pb-3 md:flex-row md:items-center md:px-8">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <EntityTile kind="app" name={slug} size="md" />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="truncate text-base font-semibold leading-tight">{app?.name ?? slug}</p>
          <div className="flex min-h-5 flex-wrap items-center gap-1.5">
            {!app ? (
              <Skeleton className="h-5 w-32" />
            ) : (
              <>
                <Badge variant={state && isKnownState(state) ? STATE_VARIANT[state] : "default"} dot title={app.status.last_error ?? undefined}>
                  {state && isKnownState(state) ? t(`state.${state}`) : state}
                </Badge>
                {view ? <Badge variant="blue">{t(`access.${view.access}`)}</Badge> : null}
                {app.live_version !== null ? (
                  <Link
                    to="/$org/apps/$app/deployments"
                    params={{ org, app: slug }}
                    title={t("openDeployments")}
                    className="rounded-md outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    <Badge variant="outline">{t("live", { version: app.live_version })}</Badge>
                  </Link>
                ) : (
                  <Badge variant="outline">{t("noLive")}</Badge>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {view ? <UrlBar url={view.url} className="w-full md:w-[380px] md:shrink-0" /> : <Skeleton className="h-10 w-full md:w-[380px] md:shrink-0" />}
    </div>
  );
}

// useTabShortcuts: "g" then a section's key opens that tab. Never while typing or with a modifier held.
function useTabShortcuts(org: string, slug: string) {
  const navigate = useNavigate();
  useEffect(() => {
    let armedAt = 0;
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      const armed = Date.now() - armedAt < 1000;
      armedAt = 0;
      if (!armed) {
        if (e.key === "g") armedAt = Date.now();
        return;
      }
      const section = APP_SECTIONS.find((s) => s.shortcut === e.key);
      if (section) void navigate({ to: section.to as "/$org/apps/$app", params: { org, app: slug } });
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navigate, org, slug]);
}

// AppTabs is the app navigation at every width: a snap-scrolling strip under the app header.
export function AppTabs({ org, slug }: { org: string; slug: string }) {
  const location = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const { t } = useTranslation("shell");
  useTabShortcuts(org, slug);

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
    <div className="sticky top-12 z-[5] border-b border-line bg-bg">
      <nav
        ref={navRef}
        aria-label={t("nav.appSections")}
        onScroll={measure}
        style={fade}
        className="flex snap-x snap-mandatory scroll-px-3 gap-1 overflow-x-auto px-3 [scrollbar-width:none] md:px-6"
      >
        {APP_SECTIONS.map((s) => (
          <Link
            key={s.to}
            to={s.to}
            params={{ org, app: slug }}
            title={`g ${s.shortcut}`}
            activeOptions={{ exact: s.exact ?? false }}
            className="-mb-px flex h-10 shrink-0 snap-start items-center border-b-2 border-transparent px-2 text-sm font-medium text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
            activeProps={{ className: "border-text text-text", "aria-current": "page" }}
          >
            {t(s.labelKey)}
          </Link>
        ))}
      </nav>
    </div>
  );
}

// fadeMask fades the tab bar edges that have more tabs beyond them (a CSS mask, so no overlay).
function fadeMask({ start, end }: { start: boolean; end: boolean }): CSSProperties {
  const left = start ? "transparent, #000 32px" : "#000, #000";
  const right = end ? "#000 calc(100% - 32px), transparent" : "#000, #000";
  const mask = `linear-gradient(to right, ${left}, ${right})`;
  return { maskImage: mask, WebkitMaskImage: mask };
}
