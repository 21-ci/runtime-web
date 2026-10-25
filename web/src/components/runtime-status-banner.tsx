import { useRuntimeStatus } from "@/lib/runtime-status";
import { useTranslation } from "react-i18next";

// RuntimeStatusBanner explains that the runtime is busy or unreachable. It is not an error of
// the user's app, so it does not name any app. It stays out of layout when there is no problem.
function RuntimeStatusBanner() {
  const status = useRuntimeStatus();
  const { t } = useTranslation("shell");
  if (!status) return null;
  const text =
    status === "busy"
      ? t("runtimeStatus.busy")
      : t("runtimeStatus.unavailable");
  return (
    <div role="status" className="border-b border-line bg-panel-2 px-4 py-2 text-center text-sm text-text">
      {text}
    </div>
  );
}

export { RuntimeStatusBanner };
