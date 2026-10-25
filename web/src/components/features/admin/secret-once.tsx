import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

// SecretOnce shows a value the API returns once (a temporary password or an invite link). The value
// is plain text so screen readers and selection both work; Copy writes it to the clipboard.
export function SecretOnce({ label, value, note }: { label: string; value: string; note: string }) {
  const { t } = useTranslation(["admin", "common"]);

  function copy() {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard) {
      toast.error(t("secret.unavailable"));
      return;
    }
    clipboard.writeText(value).then(
      () => toast.success(t("secret.copied", { label })),
      () => toast.error(t("secret.failed")),
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] font-medium">{label}</p>
      <div className="flex items-stretch gap-2">
        <code className="flex min-w-0 flex-1 items-center break-all rounded-sm border border-line-strong bg-panel px-3 py-2 font-mono text-sm">
          {value}
        </code>
        <Button variant="secondary" onClick={copy} aria-label={t("secret.copyLabel", { label: label.toLowerCase() })}>
          <Copy aria-hidden="true" />
          {t("common:copy")}
        </Button>
      </div>
      <p className="text-sm text-muted">{note}</p>
    </div>
  );
}
