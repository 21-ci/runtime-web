import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMatches } from "@tanstack/react-router";
import { Menu, Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { applyTheme, readTheme, subscribeSystemTheme, writeTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { AccountMenu } from "./account-menu";
import { Breadcrumbs } from "./breadcrumbs";
import { CommandMenu } from "./command-menu";
import { ShellContext, type ShellState } from "./shell-context";
import { Sidebar } from "./sidebar";
import { ThemeToggle } from "./theme-toggle";

const COLLAPSED_KEY = "rt-sidebar-collapsed";

// Routes opt out of the centred page column (editor-like pages) with staticData.fullBleed.
declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    fullBleed?: boolean;
  }
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(v: boolean) {
  try {
    if (v) localStorage.setItem(COLLAPSED_KEY, "1");
    else localStorage.removeItem(COLLAPSED_KEY);
  } catch {
    // Storage blocked: the choice still applies for this page view.
  }
}

// AppShell is the signed-in frame: a 240px sidebar from md up (collapsible with ⌘\), a sheet
// below md, and an inset panel from md up (it scrolls on its own) with a 48px top bar and the page. It owns the shell state
// (palette, theme, collapse). The skip link is the first focus stop and jumps past the navigation.
// Org pages and instance-admin pages share it; `org` is the org in scope (null when the user has
// none, or while an admin page loads the org list).
export function AppShell({ org, children }: { org: string | null; children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setThemeState] = useState<Theme>(() => readTheme());
  const [collapsed, setCollapsedState] = useState<boolean>(() => readCollapsed());
  const matches = useMatches();
  const fullBleed = matches.some((m) => m.staticData?.fullBleed === true);
  const { t } = useTranslation("shell");

  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    // "System" follows OS scheme changes for as long as the shell is mounted.
    return subscribeSystemTheme(() => applyTheme("system"));
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    writeTheme(next);
    setThemeState(next);
  }, []);

  const setCollapsed = useCallback((next: boolean) => {
    writeCollapsed(next);
    setCollapsedState(next);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const shell = useMemo<ShellState>(
    () => ({ paletteOpen, setPaletteOpen, theme, setTheme, collapsed, setCollapsed }),
    [paletteOpen, theme, setTheme, collapsed, setCollapsed],
  );

  return (
    <ShellContext.Provider value={shell}>
      <SidebarProvider open={!collapsed} onOpenChange={(open) => setCollapsed(!open)} className="min-h-dvh bg-bg text-text md:bg-panel">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface-2 focus:px-3 focus:py-2 focus:shadow-menu"
        >
          {t("top.skipToContent")}
        </a>

        <Sidebar org={org} />

        <div className="flex min-w-0 flex-1 flex-col md:my-2 md:mr-2 md:h-[calc(100dvh-1rem)] md:overflow-y-auto md:rounded-xl md:border md:border-line md:bg-bg md:shadow-card">
          <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-1 border-b border-line bg-bg px-2 md:px-4">
            <MobileNavButton label={t("top.openNavigation")} />

            <Breadcrumbs org={org} />

            {org ? (
              <Button variant="ghost" size="icon" aria-label={t("top.search")} onClick={() => setPaletteOpen(true)} className="md:hidden">
                <Search aria-hidden="true" />
              </Button>
            ) : null}
            <ThemeToggle className="ml-1 hidden sm:inline-flex" />
            <AccountMenu />
          </header>

          <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
            {fullBleed ? children : <PageBody>{children}</PageBody>}
          </main>
        </div>

        {org ? <CommandMenu org={org} /> : null}
      </SidebarProvider>
    </ShellContext.Provider>
  );
}

// MobileNavButton opens the library sidebar's sheet.
function MobileNavButton({ label }: { label: string }) {
  const { setOpenMobile } = useSidebar();
  return (
    <Button variant="ghost" size="icon" className="md:hidden" aria-label={label} onClick={() => setOpenMobile(true)}>
      <Menu aria-hidden="true" />
    </Button>
  );
}

// PageBody centres page content with the standard gutters. `wide` removes the max width for
// editor-like pages; `flush` removes the padding too.
export function PageBody({
  children,
  wide = false,
  flush = false,
  className,
}: {
  children: ReactNode;
  wide?: boolean;
  flush?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-full min-w-0 flex-1 flex-col",
        !flush && "px-4 py-5 md:px-8 md:py-7",
        !wide && "mx-auto max-w-[1100px]",
        className,
      )}
    >
      {children}
    </div>
  );
}
