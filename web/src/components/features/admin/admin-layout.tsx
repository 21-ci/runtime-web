import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

// AdminLayout frames the instance-admin pages. They sit outside an org, so they carry their own
// header with section tabs and a way back to the console.
export function AdminLayout({ children }: { children: ReactNode }) {
  const tabClass =
    "inline-flex h-7 items-center rounded-sm px-2.5 text-sm font-medium text-muted hover:bg-text/[0.05] hover:text-text aria-[current=page]:bg-text/[0.07] aria-[current=page]:text-text";
  return (
    <div className="min-h-dvh bg-bg text-text">
      <header className="border-b border-line bg-surface px-4 py-3 md:px-10">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">Instance admin</h1>
          <Link to="/" className="ml-auto text-sm text-muted hover:text-text">
            Back to console
          </Link>
        </div>
      </header>
      <div className="mx-auto flex max-w-6xl flex-col gap-5 p-4 md:px-10 md:py-8">
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
          <Link to="/admin/node" className={tabClass} activeProps={{ "aria-current": "page" }}>
            Node
          </Link>
          <Link to="/admin/cache" className={tabClass} activeProps={{ "aria-current": "page" }}>
            Cache
          </Link>
          <Link to="/admin/domains" className={tabClass} activeProps={{ "aria-current": "page" }}>
            Domains
          </Link>
          <Link to="/admin/settings" className={tabClass} activeProps={{ "aria-current": "page" }}>
            Settings
          </Link>
        </nav>
        <main id="main" className="flex min-w-0 flex-col gap-6">
          {children}
        </main>
      </div>
    </div>
  );
}
