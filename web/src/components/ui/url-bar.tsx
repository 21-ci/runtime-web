import { Check, Copy, ExternalLink, RotateCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

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

export function CopyButton({ text, label, size = "icon-sm" }: { text: string; label?: string; size?: "icon" | "icon-sm" }) {
  const { copied, copy } = useCopy();
  const { t } = useTranslation();
  const name = copied ? t("copied") : (label ?? t("copy"));
  return (
    <Button
      variant="ghost"
      size={size}
      aria-label={name}
      title={name}
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
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex h-10 min-w-0 items-center gap-2 rounded-lg border border-line bg-panel pl-2 pr-1 shadow-card",
        className,
      )}
    >
      {badge}
      {onReload ? (
        <Button variant="ghost" size="icon-sm" aria-label={t("reload")} title={t("reload")} onClick={onReload}>
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
      <CopyButton text={url} label={t("copyUrl")} />
      <Button asChild variant="ghost" size="icon-sm" aria-label={t("openInNewTab")} title={t("openInNewTab")}>
        <a href={url} target="_blank" rel="noreferrer">
          <ExternalLink aria-hidden="true" />
        </a>
      </Button>
    </div>
  );
}
