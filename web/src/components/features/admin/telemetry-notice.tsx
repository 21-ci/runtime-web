import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";

const DOCS = "https://21-ci.github.io/runtime-web/admin/operations/#telemetry";

// TelemetryNotice shows whether this node reports. The opt-out stays on the node: the runtime is the only side that
// sends, and it reads the setting from its own configuration.
export function TelemetryNotice() {
  const { t } = useTranslation(["plans", "admin"]);
  const state = useQuery({
    queryKey: ["admin", "telemetry"],
    queryFn: () => api.get<{ sending: boolean | null }>("/admin/telemetry"),
    retry: false,
  });
  const sending = state.data?.sending;
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{t("telemetry.title")}</h2>
        {sending === true ? (
          <Badge variant="info" dot>{t("telemetry.on")}</Badge>
        ) : sending === false ? (
          <Badge variant="default">{t("telemetry.off")}</Badge>
        ) : state.data ? (
          <Badge variant="outline">{t("admin:telemetryUnknown")}</Badge>
        ) : null}
      </div>
      <p className="text-[13px] text-muted">{t("telemetry.body")}</p>
      <p className="text-[13px] text-muted">{t("telemetry.optOut")}</p>
      <a href={DOCS} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 self-start text-sm underline">
        {t("telemetry.link")}
        <ExternalLink className="size-3" aria-hidden="true" />
      </a>
    </section>
  );
}
