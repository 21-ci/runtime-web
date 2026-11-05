import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

// RangeSwitch: the time range of a page's charts, in one row above them.
export function RangeSwitch<R extends string>({ ranges, value, onChange }: { ranges: readonly R[]; value: R; onChange: (r: R) => void }) {
  const { t } = useTranslation("monitoring");
  return (
    <div role="group" aria-label={t("range.label")} className="flex flex-wrap gap-1">
      {ranges.map((r) => (
        <Button key={r} size="sm" variant={r === value ? "default" : "secondary"} aria-pressed={r === value} onClick={() => onChange(r)}>
          {t(`range.${r}` as "range.1h")}
        </Button>
      ))}
    </div>
  );
}
