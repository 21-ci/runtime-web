import type { UseQueryResult } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { SectionCard } from "@/components/ui/section-card";
import { ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

import type { Migrations } from "./use-versions";

const REFUSALS = new Set(["migration_failed", "migration_drift", "migration_out_of_order", "migration_timeout", "transaction_control_forbidden"]);

/** A dry run that says the migrations cannot run. Anything else (a busy node, a timeout) decides nothing. */
export function migrationRefused(e: unknown): boolean {
  return e instanceof ApiError && REFUSALS.has(e.code);
}

// MigrationsCard: shown once an App has any migrations at all.
export function MigrationsCard({ migrations }: { migrations: Migrations }) {
  const { t } = useTranslation("monitoring");
  if (migrations.applied.length === 0 && migrations.pending_for_latest.length === 0) return null;
  return (
    <SectionCard title={t("migrations.title")} description={t("migrations.description")}>
      <div className="grid min-w-0 gap-4 text-sm md:grid-cols-2">
        <div>
          <h3 className="mb-1 font-medium">{t("migrations.pending")}</h3>
          {migrations.pending_for_latest.length === 0 ? (
            <p className="text-muted">{t("migrations.none")}</p>
          ) : (
            <ul className="font-mono text-xs">
              {migrations.pending_for_latest.map((m) => (
                <li key={m.name} className="break-all">{m.name}</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="mb-1 font-medium">{t("migrations.applied")}</h3>
          {migrations.applied.length === 0 ? (
            <p className="text-muted">{t("migrations.none")}</p>
          ) : (
            <ul className="font-mono text-xs">
              {migrations.applied.map((m) => (
                <li key={m.name} className="flex flex-wrap justify-between gap-2">
                  <span className="break-all">{m.name}</span>
                  <span className="text-muted">v{m.version}, {formatDateTime(m.applied_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

// PromotePreflight: the promote dialog's result of running the migrations on a copy of the data.
export function PromotePreflight({ check }: { check: UseQueryResult<{ pending_migrations: string[] }> }) {
  const { t } = useTranslation("monitoring");
  if (check.isPending) return <p className="text-sm text-muted">{t("migrations.checking")}</p>;
  if (check.isError) {
    const e = check.error;
    const d = e instanceof ApiError ? e.details : undefined;
    return (
      <p role="alert" className="break-words text-sm text-danger-text">
        {typeof d?.file === "string"
          ? t("migrations.failed", { file: d.file, statement: String(d.statement_index ?? ""), message: String(d.message ?? "") })
          : t("migrations.failedPlain", { code: e instanceof ApiError ? e.code : "" })}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p>{t("migrations.promoteWill")}</p>
      <ul className="font-mono text-xs">
        {check.data.pending_migrations.map((n) => (
          <li key={n} className="break-all">{n}</li>
        ))}
      </ul>
      <p className="text-xs text-muted">{t("migrations.compat")}</p>
    </div>
  );
}
