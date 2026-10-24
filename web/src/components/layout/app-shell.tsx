import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { useMatches } from "@tanstack/react-router";
import { Menu, PanelLeft, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
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
// below md, a 48px top bar with breadcrumbs, and the page content. It owns the shell state
// (palette, theme, collapse). The skip link is the first focus stop and jumps past the navigation.
// `nav` replaces the org sidebar (the admin area passes its own) and `crumbs` the breadcrumbs.
export function AppShell({
  org,
  nav,
  crumbs,
  children,
}: {
  org: string | null;
  nav?: (props: { onNavigate?: () => void; onCollapse?: () => void }) => ReactNode;
  crumbs?: ReactNode;
  children: ReactNode;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setThemeState] = useState<Theme>(() => readTheme());
  const [collapsed, setCollapsedState] = useState<boolean>(() => readCollapsed());
  const matches = useMatches();
  const fullBleed = matches.some((m) => m.staticData?.fullBleed === true);

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
      } else if (e.key === "\\") {
        e.preventDefault();
        setCollapsedState((v) => {
          writeCollapsed(!v);
          return !v;
        });
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const shell = useMemo<ShellState>(
    () => ({ paletteOpen, setPaletteOpen, theme, setTheme, collapsed, setCollapsed }),
    [paletteOpen, theme, setTheme, collapsed, setCollapsed],
  );

  const renderNav = (props: { onNavigate?: () => void; onCollapse?: () => void }) =>
    nav ? nav(props) : org ? <Sidebar org={org} {...props} /> : null;

  return (
    <ShellContext.Provider value={shell}>
      <div className="flex min-h-dvh bg-bg text-text">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface-2 focus:px-3 focus:py-2 focus:shadow-menu"
        >
          Skip to content
        </a>

        <aside
          className={cn(
            "sticky top-0 hidden h-dvh w-60 shrink-0 overflow-y-auto border-r border-line bg-panel",
            !collapsed && "md:block",
          )}
        >
          {renderNav({ onCollapse: () => setCollapsed(true) })}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-1 border-b border-line bg-bg/90 px-2 backdrop-blur-sm md:px-4">
            <SheetPrimitive.Root open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetPrimitive.Trigger asChild>
                <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
                  <Menu aria-hidden="true" />
                </Button>
              </SheetPrimitive.Trigger>
              <SheetPrimitive.Portal>
                <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay/35 data-[state=open]:animate-[fade-in_160ms_var(--motion-ease)]" />
                <SheetPrimitive.Content className="fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] overflow-y-auto border-r border-line bg-panel text-text shadow-menu outline-none data-[state=open]:animate-[slide-in-left_200ms_var(--motion-ease)]">
                  <SheetPrimitive.Title className="sr-only">Navigation</SheetPrimitive.Title>
                  <SheetPrimitive.Description className="sr-only">Console navigation</SheetPrimitive.Description>
                  {renderNav({ onNavigate: () => setSheetOpen(false) })}
                </SheetPrimitive.Content>
              </SheetPrimitive.Portal>
            </SheetPrimitive.Root>

            {collapsed ? (
              <Button
                variant="ghost"
                size="icon"
                className="hidden md:inline-flex"
                aria-label="Expand sidebar"
                title="Expand sidebar (⌘\)"
                onClick={() => setCollapsed(false)}
              >
                <PanelLeft aria-hidden="true" />
              </Button>
            ) : null}

            {crumbs ?? (org ? <Breadcrumbs org={org} /> : <div className="flex-1" />)}

            <Button variant="ghost" size="icon" aria-label="Search" onClick={() => setPaletteOpen(true)} className="md:hidden">
              <Search aria-hidden="true" />
            </Button>
            <ThemeToggle className="ml-1 hidden sm:inline-flex" />
            <AccountMenu />
          </header>

          <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
            {fullBleed ? children : <PageBody>{children}</PageBody>}
          </main>
        </div>

        {org ? <CommandMenu org={org} /> : null}
      </div>
    </ShellContext.Provider>
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
