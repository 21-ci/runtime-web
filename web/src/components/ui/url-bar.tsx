import { Check, Copy, ExternalLink, RotateCw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Button } from "./button";

// useCopy copies text to the clipboard and reports "copied" for a moment.
export function useCopy(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  function copy(text: string) {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }
  return { copied, copy };
}

export function CopyButton({ text, label = "Copy", size = "icon-sm" }: { text: string; label?: string; size?: "icon" | "icon-sm" }) {
  const { copied, copy } = useCopy();
  return (
    <Button
      variant="ghost"
      size={size}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() => copy(text)}
    >
      {copied ? <Check className="text-tag-green-text" aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </Button>
  );
}

// UrlBar shows the live URL of an app with a leading badge, a copy button, an open-in-new-tab
// link and an optional reload action (val.town's URL row).
export function UrlBar({
  url,
  badge,
  onReload,
  className,
}: {
  url: string;
  badge?: ReactNode;
  onReload?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-10 min-w-0 items-center gap-2 rounded-lg border border-line bg-panel pl-2 pr-1 shadow-card",
        className,
      )}
    >
      {badge}
      {onReload ? (
        <Button variant="ghost" size="icon-sm" aria-label="Reload" title="Reload" onClick={onReload}>
          <RotateCw aria-hidden="true" />
        </Button>
      ) : null}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 flex-1 truncate font-mono text-[13px] text-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
      >
        {url}
      </a>
      <CopyButton text={url} label="Copy URL" />
      <Button asChild variant="ghost" size="icon-sm" aria-label="Open in new tab" title="Open in new tab">
        <a href={url} target="_blank" rel="noreferrer">
          <ExternalLink aria-hidden="true" />
        </a>
      </Button>
    </div>
  );
}
