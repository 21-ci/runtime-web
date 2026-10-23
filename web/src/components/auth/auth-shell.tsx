import type { ReactNode } from "react";

// AuthShell is the card used by every sign-in page. It is pinned near the top (not centered) so
// the title does not move while async config loads and the form appears below it.
function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh justify-center px-4 pt-[12vh] pb-8 sm:pt-[18vh]">
      <div className="w-full max-w-sm">
        <h1 className="mb-4 text-lg font-semibold text-text">{title}</h1>
        <div className="rounded-[6px] border border-line bg-surface p-5 sm:p-6">{children}</div>
      </div>
    </main>
  );
}

export { AuthShell };
