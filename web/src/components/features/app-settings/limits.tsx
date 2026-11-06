import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { KeyValueRows, objectFromRows, rowsFromObject, type KvRow } from "@/components/ui/key-value-rows";
import { Label } from "@/components/ui/label";
import { type AppDetail, usePatchApp } from "./api";
import { readableLimits, sourceLabel } from "./limit-format";
import { FieldError, FormAlert, Section, fieldErrorsOf, SaveButton, unmappedErrors } from "./shared";

const SOURCE_KEY = {
  plan: "limits.sources.plan",
  profile: "limits.sources.profile",
  service: "limits.sources.service",
} as const satisfies Record<AppDetail["limits"]["source"], string>;

// LimitsSection shows what the app asked for next to what it actually gets, and where that comes
// from. The requested block is edited as name and value rows; the effective block is read-only.
export function LimitsSection({ org, app }: { org: string; app: AppDetail }) {
  const { t } = useTranslation(["app-settings", "common"]);
  const [profile, setProfile] = useState(app.profile ?? "");
  const [rows, setRows] = useState<KvRow[]>(() => rowsFromObject(app.limits.requested ?? {}));
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [errors, setErrors] = useState<string[]>([]);
  const patch = usePatchApp(org, app.slug);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const built = objectFromRows(rows, {
      keyRequired: t("limits.keyRequired"),
      valueRequired: t("limits.valueRequired"),
      duplicateKey: t("limits.duplicateKey"),
    });
    if ("errors" in built) {
      setRowErrors(built.errors);
      return;
    }
    setRowErrors({});
    setFieldError(undefined);
    setErrors([]);
    try {
      await patch.mutateAsync({
        etag: app.etag,
        body: { profile: profile.trim() === "" ? null : profile.trim(), limits: built.value },
      });
      toast.success(t("limits.saved"));
    } catch (err) {
      const server = fieldErrorsOf(err);
      setFieldError(server.limits);
      setErrors(unmappedErrors(server, ["limits"]));
    }
  }

  return (
    <Section id="limits" title={t("limits.title")} description={t("limits.description")}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-sm border border-line p-3">
          <p className="text-[13px] font-medium text-text">{t("limits.requested")}</p>
          <LimitList values={app.limits.requested ?? {}} empty={t("limits.nothingRequested")} />
        </div>
        <div className="flex flex-col gap-2 rounded-sm border border-line p-3">
          <p className="text-[13px] font-medium text-text">{t("limits.effective")}</p>
          <LimitList values={app.limits.effective} empty={t("limits.noLimits")} />
          <p className="text-sm text-muted">
            {t("limits.sourceLabel")} <span className="text-text">{t(SOURCE_KEY[app.limits.source])}</span>
          </p>
        </div>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-label={t("limits.formLabel")}>
        <div className="flex flex-col gap-1">
          <Label htmlFor="limits-profile">{t("limits.profile")}</Label>
          <Input id="limits-profile" value={profile} onChange={(e) => setProfile(e.target.value)} placeholder={t("limits.profilePlaceholder")} />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[13px] font-medium text-text">{t("limits.requestedRows")}</legend>
          <p className="text-[13px] text-muted">{t("limits.rowsHint")}</p>
          <KeyValueRows
            idPrefix="limits"
            rows={rows}
            onChange={setRows}
            errors={rowErrors}
            labels={{
              key: t("limits.limitName"),
              value: t("limits.limitValue"),
              add: t("limits.addRow"),
              remove: (key) => t("limits.removeRow", { key }),
              keyPlaceholder: "wall_ms",
              valuePlaceholder: "30000",
            }}
          />
          <FieldError id="limits-error" message={fieldError} />
        </fieldset>
        <FormAlert messages={errors} />
        <div>
          <SaveButton disabled={patch.isPending}>
            {t("limits.save")}
          </SaveButton>
        </div>
      </form>
    </Section>
  );
}

// LimitList renders limits as a key/value list with units, so a number reads as "1 MiB" or "30 s".
function LimitList({ values, empty }: { values: Record<string, unknown>; empty: string }) {
  if (Object.keys(values).length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {readableLimits(values).map((r) => (
          <div key={r.key} className="contents">
            <dt className="min-w-0 break-words text-muted">{r.label}</dt>
            <dd className="min-w-0 break-words text-right text-text tabular-nums">
              {r.value}
              {r.source ? <span className="block text-xs text-muted">{sourceLabel(r.source)}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}
