import { ExternalLink, MonitorOff } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { Button } from "./button";

// PreviewFrame embeds the app's live URL. When the console's Content-Security-Policy refuses to
// frame that origin (the browser reports a securitypolicyviolation for frame-src/child-src), it
// shows an explanation with an open-in-new-tab link instead of the browser's broken-page icon.
export function PreviewFrame({
  url,
  title,
  reloadKey = 0,
  className,
}: {
  url: string;
  title: string;
  reloadKey?: number;
  className?: string;
}) {
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    function onViolation(e: SecurityPolicyViolationEvent) {
      const directive = e.effectiveDirective || e.violatedDirective;
      if (!/^(frame-src|child-src|default-src)$/.test(directive)) return;
      if (e.blockedURI && url.startsWith(e.blockedURI)) setBlocked(true);
      else if (e.blockedURI === "" || e.blockedURI === "blob" || e.blockedURI === "inline") setBlocked(true);
    }
    document.addEventListener("securitypolicyviolation", onViolation);
    return () => document.removeEventListener("securitypolicyviolation", onViolation);
  }, [url]);

  if (blocked) {
    return (
      <div
        role="note"
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border border-line bg-panel p-6 text-center shadow-card",
          className,
        )}
      >
        <MonitorOff className="size-5 text-muted" aria-hidden="true" />
        <p className="text-sm font-medium">Preview can't be embedded here</p>
        <p className="max-w-[40ch] text-[13px] text-muted">
          The console's security policy does not allow framing this app's origin. Open it in a new tab instead.
        </p>
        <Button asChild variant="secondary" size="sm" className="mt-1">
          <a href={url} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden="true" /> Open app
          </a>
        </Button>
      </div>
    );
  }

  return (
    <iframe
      key={reloadKey}
      title={title}
      src={url}
      sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
      className={cn("w-full rounded-lg border border-line bg-white shadow-card [color-scheme:light]", className)}
    />
  );
}
