import { useState } from "react";
import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { getBlob } from "@/lib/api";
import { errorMessage } from "@/lib/error-message";

// ExportDataButton downloads the app's SQLite snapshot through fetch rather than a plain link, so a
// refusal shows as a message instead of a saved error body, and a download cut midway saves nothing:
// the next click starts over from byte zero with a new snapshot.
export function ExportDataButton({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation("empty");
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      const blob = await getBlob(`/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}/export`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${app}.sqlite`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onClick()}>
      <Download aria-hidden="true" /> {t("data.download")}
    </Button>
  );
}
