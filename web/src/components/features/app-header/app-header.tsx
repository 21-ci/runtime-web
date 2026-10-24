import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { APP_SECTIONS } from "@/components/layout/sidebar";
import type { AppSummary } from "@/hooks/orgs";

// AppTabs is the phone-width app navigation: a snap-scrolling tab strip under the top bar with
// the same sections the sidebar lists on wider screens (where this strip is hidden).
export function AppTabs({ org, app }: { org: string; app: AppSummary }) {
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
    <div className="sticky top-12 z-[5] border-b border-line bg-bg md:hidden">
      <nav
        ref={navRef}
        aria-label="App sections"
        onScroll={measure}
        style={fade}
        className="flex snap-x snap-mandatory scroll-px-3 gap-1 overflow-x-auto px-3 [scrollbar-width:none]"
      >
        {APP_SECTIONS.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            params={{ org, app: app.slug }}
            activeOptions={{ exact: t.exact ?? false }}
            className="-mb-px flex h-10 shrink-0 snap-start items-center border-b-2 border-transparent px-2 text-sm font-medium text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
            activeProps={{ className: "border-text text-text", "aria-current": "page" }}
          >
            {t.label}
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
