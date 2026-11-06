import { useTranslation } from "react-i18next";

import { useMigrations } from "@/components/features/deployments/use-versions";
import { Badge } from "@/components/ui/badge";

// RollbackChecklist says what going back does not undo. Migrations newer than the target stay applied,
// so the old code runs against the newer schema.
export function RollbackChecklist({ org, app, version }: { org: string; app: string; version: number }) {
  const { t } = useTranslation("operator");
  const migrations = useMigrations(org, app);
  const kept = (migrations.data?.applied ?? []).filter((m) => m.version > version).map((m) => m.name);
  return (
    <div className="flex flex-col gap-2 text-sm">
      {kept.length > 0 ? (
        <div role="alert" className="flex flex-col gap-1.5 rounded-md bg-tag-yellow-bg px-3 py-2 text-tag-yellow-text">
          <p>{t("rollback.migrationsStay", { count: kept.length, version })}</p>
          <ul className="flex flex-wrap gap-1">
            {kept.map((n) => <li key={n}><Badge variant="outline">{n}</Badge></li>)}
          </ul>
        </div>
      ) : migrations.isError ? (
        <p role="alert">{t("rollback.migrationsUnknown")}</p>
      ) : null}
      <ul className="flex list-disc flex-col gap-1 pl-5 text-muted">
        <li>{t("rollback.dataStays")}</li>
        <li>{t("rollback.envCurrent")}</li>
        <li>{t("rollback.inFlight")}</li>
      </ul>
    </div>
  );
}
