import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { Menu, PanelLeft, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { applyTheme, readTheme, writeTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { AccountMenu } from "./account-menu";
import { Breadcrumbs } from "./breadcrumbs";
import { CommandMenu } from "./command-menu";
import { ShellContext, type ShellState } from "./shell-context";
import { Sidebar } from "./sidebar";
import { ThemeToggle } from "./theme-toggle";

// SHORTCUT_LABEL names the palette key for the platform: ⌘K on Apple devices, Ctrl K elsewhere.
const SHORTCUT_LABEL =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘K" : "Ctrl K";

const COLLAPSED_KEY = "rt-sidebar-collapsed";

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
// below md, a 44px topbar with breadcrumbs, and the page content. It owns the shell state (palette,
// theme, collapse). The skip link is the first focus stop and jumps past the navigation.
export function AppShell({ org, children }: { org: string; children: ReactNode }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setThemeState] = useState<Theme>(() => readTheme());
  const [collapsed, setCollapsedState] = useState<boolean>(() => readCollapsed());

  useEffect(() => {
    applyTheme(theme);
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
    () => ({
      paletteOpen,
      setPaletteOpen,
      theme,
      setTheme,
      collapsed,
      setCollapsed,
    }),
    [paletteOpen, theme, setTheme, collapsed, setCollapsed],
  );

  return (
    <ShellContext.Provider value={shell}>
      <div className="flex min-h-dvh bg-bg text-text">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-menu"
        >
          Skip to content
        </a>

        <aside
          className={cn(
            "sticky top-0 hidden h-dvh w-60 shrink-0 overflow-y-auto bg-panel",
            !collapsed && "md:block",
          )}
        >
          <Sidebar org={org} onCollapse={() => setCollapsed(true)} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-10 flex h-12 items-center gap-1.5 bg-bg/95 px-3 md:px-5">
            <SheetPrimitive.Root open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetPrimitive.Trigger asChild>
                <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
                  <Menu className="size-4" aria-hidden="true" />
                </Button>
              </SheetPrimitive.Trigger>
              <SheetPrimitive.Portal>
                <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay/30" />
                <SheetPrimitive.Content className="fixed inset-y-0 left-0 z-50 w-60 max-w-[85vw] overflow-y-auto bg-panel text-text shadow-menu outline-none transition-transform duration-[160ms] ease-ui starting:-translate-x-full">
                  <SheetPrimitive.Title className="sr-only">Navigation</SheetPrimitive.Title>
                  <SheetPrimitive.Description className="sr-only">
                    Organization projects and apps
                  </SheetPrimitive.Description>
                  <Sidebar org={org} onNavigate={() => setSheetOpen(false)} />
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
                <PanelLeft className="size-4" aria-hidden="true" />
              </Button>
            ) : null}

            <Breadcrumbs org={org} />

            <Button
              variant="ghost"
              size="icon"
              aria-label="Search"
              onClick={() => setPaletteOpen(true)}
              className="sm:hidden"
            >
              <Search className="size-4" aria-hidden="true" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              aria-label="Open command menu"
              onClick={() => setPaletteOpen(true)}
              className="hidden text-muted sm:inline-flex"
            >
              <Search className="size-4" aria-hidden="true" /> Search
              <kbd className="ml-2 rounded-md bg-surface px-1.5 font-mono text-[11px] text-muted">
                {SHORTCUT_LABEL}
              </kbd>
            </Button>
            <ThemeToggle className="ml-1 hidden sm:inline-flex" />
            <AccountMenu />
          </header>

          <main
            id="main"
            tabIndex={-1}
            className="mx-auto w-full max-w-[1100px] flex-1 p-4 outline-none md:px-10 md:py-8"
          >
            {children}
          </main>
        </div>

        <CommandMenu org={org} />
      </div>
    </ShellContext.Provider>
  );
}
