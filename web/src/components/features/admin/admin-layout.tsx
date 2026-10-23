import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

// AdminLayout frames the instance-admin pages. They sit outside an org, so they carry their own
// header with section tabs and a way back to the console.
export function AdminLayout({ children }: { children: ReactNode }) {
  const tabClass =
    "inline-flex h-8 items-center rounded-[7px] px-3 text-sm font-semibold text-muted hover:bg-panel-2 hover:text-text aria-[current=page]:bg-panel-2 aria-[current=page]:text-text";
  return (
    <div className="min-h-dvh bg-bg text-text">
      <header className="border-b border-line bg-surface px-4 py-3 md:px-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
          <Link to="/" className="text-sm text-muted hover:text-text">
            Back to console
          </Link>
          <h1 className="ml-auto text-base font-semibold">Instance admin</h1>
        </div>
      </header>
      <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 md:p-6">
        <nav aria-label="Admin sections" className="flex flex-wrap gap-1">
          <Link to="/admin/users" className={tabClass} activeProps={{ "aria-current": "page" }}>
            Users
          </Link>
          <Link to="/admin/orgs" className={tabClass} activeProps={{ "aria-current": "page" }}>
            Organizations
          </Link>
          <Link to="/admin/audit" className={tabClass} activeProps={{ "aria-current": "page" }}>
            Audit log
          </Link>
        </nav>
        <main id="main" className="flex min-w-0 flex-col gap-6">
          {children}
        </main>
      </div>
    </div>
  );
}
