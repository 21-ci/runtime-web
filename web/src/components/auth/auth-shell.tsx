import type { ReactNode } from "react";

// AuthShell is the centered card used by every sign-in page. The min-height keeps the layout
// stable while async config loads, so the form does not jump when it appears.
function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-center text-xl font-semibold text-text">{title}</h1>
        <div className="min-h-[360px] rounded-[6px] border border-line bg-surface p-6">{children}</div>
      </div>
    </main>
  );
}

export { AuthShell };
