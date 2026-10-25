import { useTranslation } from "react-i18next";

import { QueryError } from "@/components/features/empty/query-error";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";

import { useOnceSchedules } from "./hooks";

// OnceSchedulesCard lists the one-off tasks the app's code queued with std:schedule
// (after/at). They are read-only here: code creates and cancels them.
export function OnceSchedulesCard({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation(["triggers", "common"]);
  const once = useOnceSchedules(org, app);

  return (
    <section aria-labelledby="once-schedules-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="once-schedules-heading" className="text-[15px] font-semibold">
          {t("oneOff.title")}
        </h2>
        <p className="text-sm text-muted">{t("oneOff.description")}</p>
      </div>
      {once.isError ? (
        <QueryError error={once.error} onRetry={() => void once.refetch()} notFoundTitle={t("oneOff.notFound")} />
      ) : once.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : once.data.length === 0 ? (
        <p className="text-sm text-muted">{t("oneOff.empty")}</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface shadow-card">
          {once.data.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <code className="text-xs">{s.id}</code>
              <span className="text-xs text-muted">{t("oneOff.runs", { when: formatDateTime(s.run_at) })}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
