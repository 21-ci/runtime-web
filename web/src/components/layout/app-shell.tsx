import { useState, type ReactNode } from "react";
import { Menu, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useOrgs } from "@/hooks/orgs";
import { AccountMenu } from "./account-menu";
import { CommandMenu } from "./command-menu";
import { Sidebar } from "./sidebar";
import { ThemeToggle } from "./theme-toggle";

// SHORTCUT_LABEL names the palette key for the platform: ⌘K on Apple devices, Ctrl K elsewhere.
const SHORTCUT_LABEL =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘K" : "Ctrl K";

// AppShell is the signed-in frame: a fixed sidebar from md up, a sheet below md, a topbar and the
// page content. The skip link is the first focus stop and jumps past the navigation.
export function AppShell({ org, children }: { org: string; children: ReactNode }) {
  const orgs = useOrgs();
  const [sheetOpen, setSheetOpen] = useState(false);
  const current = orgs.data?.find((o) => o.slug === org);

  // The command menu listens for ⌘K / Ctrl K, so the topbar buttons reuse that keydown.
  function openCommandMenu() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  }

  return (
    <div className="flex min-h-dvh bg-bg text-text">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-[6px] focus:bg-surface focus:px-3 focus:py-2 focus:shadow-[0_8px_24px_-12px_rgb(0_0_0_/0.35)]"
      >
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 overflow-y-auto border-r border-line bg-panel md:block">
        <Sidebar org={org} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b border-line bg-surface px-3 md:px-6">
          <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
                <Menu className="size-5" aria-hidden="true" />
              </Button>
            </DialogTrigger>
            <DialogContent className="left-0 top-0 h-dvh w-72 max-w-[85vw] translate-x-0 translate-y-0 overflow-y-auto rounded-none p-0">
              <DialogTitle className="sr-only">Navigation</DialogTitle>
              <DialogDescription className="sr-only">Organization projects and apps</DialogDescription>
              <Sidebar org={org} onNavigate={() => setSheetOpen(false)} />
            </DialogContent>
          </Dialog>

          <p className="min-w-0 flex-1 truncate text-sm text-muted">{current?.name ?? org}</p>

          <Button variant="ghost" size="icon" aria-label="Search" onClick={openCommandMenu} className="sm:hidden">
            <Search className="size-5" aria-hidden="true" />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            aria-label="Open command menu"
            onClick={openCommandMenu}
            className="hidden sm:inline-flex"
          >
            <Search className="size-4" aria-hidden="true" /> Search
            <kbd className="ml-2 rounded border border-line px-1 text-xs text-muted">{SHORTCUT_LABEL}</kbd>
          </Button>
          <ThemeToggle />
          <AccountMenu />
        </header>

        <main id="main" tabIndex={-1} className="w-full max-w-[1280px] flex-1 p-4 outline-none md:px-8 md:py-6">
          {children}
        </main>
      </div>

      <CommandMenu org={org} />
    </div>
  );
}
