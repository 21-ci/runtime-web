import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import type { AppDetail } from "./api";

const VARIANT: Record<string, "success" | "danger" | "warning" | "default"> = {
  ready: "success",
  failed: "danger",
  building: "warning",
  pending: "warning",
};

// StatusPill shows the runtime status of the app: build state, tier, in-flight calls, and the last
// error when there is one.
export function StatusPill({ status }: { status: AppDetail["status"] }) {
  const { t } = useTranslation("app-settings");
  return (
    <div role="status" aria-label={t("status.label")} className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {/* build_state is a runtime value (ready, failed, ...) and stays as the runtime reports it. */}
        <Badge variant={VARIANT[status.build_state] ?? "default"} dot>
          {status.build_state}
        </Badge>
        <span className="text-[12px] text-muted">{t("status.tier", { tier: status.tier })}</span>
        <span className="text-[12px] text-muted">{t("status.inflight", { count: status.inflight })}</span>
      </div>
      {status.last_error ? <p className="text-danger-text">{status.last_error}</p> : null}
    </div>
  );
}
