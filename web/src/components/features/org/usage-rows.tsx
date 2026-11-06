import { useTranslation } from "react-i18next";

import { UsageBar, UsageStatusLabel, getUsageStatus } from "@/components/dashboardblocks/usage-meter";

// UsageRows: the rows of the library's usage-meter-06 (business/usage-meter-06), with its UsageBar and
// status label, and text passed in so that it can be translated. The console's SectionCard is its card.
export type UsageRow = {
  key: string;
  label: string;
  amount: string;
  /** Null when there is nothing a bar could measure: no limit, or a counter that is not metered. */
  used: number | null;
  limit: number | null;
  note?: string | null | undefined;
};

export const NEAR_PCT = 75;
export const FULL_PCT = 90;

export function UsageRows({ rows, ariaLabel }: { rows: readonly UsageRow[]; ariaLabel: (label: string) => string }) {
  const { t } = useTranslation("operator");
  const statusLabels = { warning: t("plan.statusNear"), critical: t("plan.statusCritical"), over: t("plan.statusOver") };
  return (
    <ul className="flex flex-col divide-y divide-line">
      {rows.map((row) => {
        const metered = row.used !== null && row.limit !== null && row.limit > 0;
        const status = metered ? getUsageStatus(row.used as number, row.limit as number, { warning: NEAR_PCT, critical: FULL_PCT }) : "ok";
        return (
          <li key={row.key} className="flex flex-col gap-2 py-2.5 first:pt-0 last:pb-0">
            <div className="flex min-w-0 items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{row.label}</span>
              <span className="flex min-w-0 items-baseline gap-3 text-[12px]">
                {status !== "ok" ? <UsageStatusLabel className="shrink-0 text-xs" status={status} label={statusLabels[status]} /> : null}
                <span className="min-w-0 truncate tabular-nums text-muted" title={row.amount}>
                  {row.amount}
                </span>
              </span>
            </div>
            {row.note ? <p className="text-[12px] text-muted">{row.note}</p> : null}
            {metered ? (
              <div role="progressbar" aria-label={ariaLabel(row.label)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(((row.used as number) / (row.limit as number)) * 100))}>
                <UsageBar limit={row.limit as number} size="sm" used={row.used as number} warning={NEAR_PCT} critical={FULL_PCT} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
