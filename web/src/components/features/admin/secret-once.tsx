import { Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

// SecretOnce shows a value the API returns once (a temporary password or an invite link). The value
// is plain text so screen readers and selection both work; Copy writes it to the clipboard.
export function SecretOnce({ label, value, note }: { label: string; value: string; note: string }) {
  function copy() {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard) {
      toast.error("Copy is not available here. Select the text and copy it.");
      return;
    }
    clipboard.writeText(value).then(
      () => toast.success(`${label} copied`),
      () => toast.error("Copy failed. Select the text and copy it."),
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-semibold">{label}</p>
      <div className="flex items-stretch gap-2">
        <code className="flex min-w-0 flex-1 items-center break-all rounded-[7px] border border-line-strong bg-panel px-3 py-2 font-mono text-sm">
          {value}
        </code>
        <Button variant="secondary" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
          <Copy aria-hidden="true" />
          Copy
        </Button>
      </div>
      <p className="text-sm text-muted">{note}</p>
    </div>
  );
}
