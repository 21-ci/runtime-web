import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type AppDetail, usePatchApp } from "./api";
import { flattenLimits, formatLimit } from "./limit-format";
import { FieldError, FormAlert, Section, fieldErrorsOf, SaveButton, unmappedErrors } from "./shared";

const SOURCE_KEY = {
  plan: "limits.sources.plan",
  profile: "limits.sources.profile",
  service: "limits.sources.service",
} as const satisfies Record<AppDetail["limits"]["source"], string>;

// LimitsSection shows what the app asked for next to what it actually gets, and where that comes
// from. The requested block is editable JSON; the effective block is read-only.
export function LimitsSection({ org, app }: { org: string; app: AppDetail }) {
  const { t } = useTranslation(["app-settings", "common"]);
  const [profile, setProfile] = useState(app.profile ?? "");
  const [text, setText] = useState(JSON.stringify(app.limits.requested ?? {}, null, 2));
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [errors, setErrors] = useState<string[]>([]);
  const patch = usePatchApp(org, app.slug);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    let parsed: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(text);
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not object");
      parsed = v as Record<string, unknown>;
    } catch {
      setFieldError(t("limits.invalid"));
      return;
    }
    setFieldError(undefined);
    setErrors([]);
    try {
      await patch.mutateAsync({
        etag: app.etag,
        body: { profile: profile.trim() === "" ? null : profile.trim(), limits: parsed },
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
        <div className="flex flex-col gap-1">
          <Label htmlFor="limits-json">{t("limits.json")}</Label>
          <textarea
            id="limits-json"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            aria-describedby="limits-error"
            spellCheck={false}
            autoComplete="off"
            className="rounded-sm border border-line-strong bg-surface p-2 font-mono text-sm text-text focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus"
          />
          <FieldError id="limits-error" message={fieldError} />
        </div>
        <FormAlert messages={errors} />
        <p className="text-sm text-muted">{t("replaceNote")}</p>
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
  const rows = flattenLimits(values);
  if (rows.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([key, value]) => {
        const { label, value: text } = formatLimit(key, value);
        return (
          <div key={key} className="contents">
            <dt className="min-w-0 break-words text-muted">{label}</dt>
            <dd className="min-w-0 break-all text-right font-mono text-xs text-text tabular-nums">{text}</dd>
          </div>
        );
      })}
    </dl>
  );
}
