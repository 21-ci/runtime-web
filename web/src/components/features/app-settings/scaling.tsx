import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type AppDetail, usePatchApp } from "./api";
import { resolved, sourceLabel } from "./limit-format";
import { FieldError, FormAlert, Section, fieldErrorsOf, SaveButton, unmappedErrors } from "./shared";

const SHOWN = ["scaling.min_instances", "scaling.max_instances"];

// ScalingSection edits the instance range. Server 422 paths map onto the min and max inputs.
export function ScalingSection({ org, app }: { org: string; app: AppDetail }) {
  const { t } = useTranslation(["app-settings", "common", "operator"]);
  // An unset value stays empty: the runtime then uses the plan's or profile's, shown under the input.
  const [min, setMin] = useState(app.scaling?.min_instances != null ? String(app.scaling.min_instances) : "");
  const [max, setMax] = useState(app.scaling?.max_instances != null ? String(app.scaling.max_instances) : "");
  const effective = (key: string) => {
    const { value, source } = resolved(app.limits.effective[key]);
    if (value === undefined || value === null) return null;
    return t("operator:scaling.effective", { value: String(value), source: source ? sourceLabel(source) : t("operator:source.default") });
  };
  const [fields, setFields] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const patch = usePatchApp(org, app.slug);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    const minSet = min.trim() !== "";
    const maxSet = max.trim() !== "";
    const minN = Number(min);
    const maxN = Number(max);
    if (minSet && (!Number.isInteger(minN) || minN < 0)) local["scaling.min_instances"] = t("scaling.minInvalid");
    if (maxSet && (!Number.isInteger(maxN) || maxN < 1)) local["scaling.max_instances"] = t("scaling.maxInvalid");
    if (minSet && maxSet && !local["scaling.min_instances"] && !local["scaling.max_instances"] && minN > maxN) {
      local["scaling.max_instances"] = t("scaling.maxBelowMin");
    }
    setFields(local);
    setErrors([]);
    if (Object.keys(local).length > 0) return;

    try {
      await patch.mutateAsync({
        etag: app.etag,
        body: { scaling: { ...(minSet ? { min_instances: minN } : {}), ...(maxSet ? { max_instances: maxN } : {}) } },
      });
      setFields({});
      toast.success(t("scaling.saved"));
    } catch (err) {
      const server = fieldErrorsOf(err);
      setFields(server);
      setErrors(unmappedErrors(server, SHOWN));
    }
  }

  return (
    <Section id="scaling" title={t("scaling.title")} description={t("scaling.description")}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-label={t("scaling.formLabel")}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="scaling-min">{t("scaling.min")}</Label>
            <Input
              id="scaling-min"
              inputMode="numeric"
              value={min}
              placeholder={t("operator:scaling.blank")}
              onChange={(e) => setMin(e.target.value)}
              aria-invalid={Boolean(fields["scaling.min_instances"])}
              aria-describedby="scaling-min-error"
            />
            {effective("min_instances") ? <p className="text-xs text-muted">{effective("min_instances")}</p> : null}
            <FieldError id="scaling-min-error" message={fields["scaling.min_instances"]} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="scaling-max">{t("scaling.max")}</Label>
            <Input
              id="scaling-max"
              inputMode="numeric"
              value={max}
              placeholder={t("operator:scaling.blank")}
              onChange={(e) => setMax(e.target.value)}
              aria-invalid={Boolean(fields["scaling.max_instances"])}
              aria-describedby="scaling-max-error"
            />
            {effective("max_instances") ? <p className="text-xs text-muted">{effective("max_instances")}</p> : null}
            <FieldError id="scaling-max-error" message={fields["scaling.max_instances"]} />
          </div>
        </div>
        <FormAlert messages={errors} />
        <div>
          <SaveButton disabled={patch.isPending}>
            {t("scaling.save")}
          </SaveButton>
        </div>
      </form>
    </Section>
  );
}
