import { Zap } from "lucide-react";
import type { ReactNode } from "react";

import { IconTile } from "@/components/ui/icon-tile";

// AuthShell is the centered card used by every sign-in page: a small product mark, a heading, a
// line of subtext, then the form. The top offset is fixed (not vertical centering) so the heading
// does not move while async config loads and the form appears below it.
function AuthShell({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh justify-center bg-panel px-4 pb-10 pt-[10vh] sm:pt-[14vh]">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <IconTile icon={Zap} hue="blue" size="lg" solid className="shadow-card" />
          <h1 className="text-xl font-semibold tracking-[-0.015em] text-text">{title}</h1>
          {description ? <p className="max-w-[34ch] text-sm text-muted">{description}</p> : null}
        </div>
        <div className="rounded-lg border border-line bg-surface-2 p-6 shadow-card sm:p-7">{children}</div>
        <p className="mt-6 text-center text-[12px] text-muted">Runtime Console</p>
      </div>
    </main>
  );
}

export { AuthShell };
