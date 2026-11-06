import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

// NoData is the one way to say a figure or a panel has nothing to show. Inline it reads "N/A", for a
// single value; as a block it reads "No data", with an optional hint saying why. Never a blank panel,
// an empty chart or a zero standing in for a measurement.
export function NoData({ inline = false, hint, className }: { inline?: boolean; hint?: string | undefined; className?: string }) {
  const { t } = useTranslation("common");
  if (inline) return <span className={cn("text-muted", className)}>{t("na")}</span>;
  return (
    <div data-testid="no-data" className={cn("flex flex-col items-center gap-0.5 px-4 py-8 text-center", className)}>
      <p className="text-sm font-medium text-muted">{t("noData")}</p>
      {hint ? <p className="max-w-[44ch] text-[13px] text-muted">{hint}</p> : null}
    </div>
  );
}
