import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type AppDetail, usePatchApp } from "./api";
import { FieldError, FormAlert, Section, fieldErrorsOf, SaveButton, unmappedErrors } from "./shared";

const SHOWN = ["scaling.min_instances", "scaling.max_instances"];

// ScalingSection edits the instance range. Server 422 paths map onto the min and max inputs.
export function ScalingSection({ org, app }: { org: string; app: AppDetail }) {
  const { t } = useTranslation(["app-settings", "common"]);
  const [min, setMin] = useState(String(app.scaling?.min_instances ?? 0));
  const [max, setMax] = useState(String(app.scaling?.max_instances ?? 1));
  const [fields, setFields] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const patch = usePatchApp(org, app.slug);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    const minN = Number(min);
    const maxN = Number(max);
    if (!Number.isInteger(minN) || minN < 0) local["scaling.min_instances"] = t("scaling.minInvalid");
    if (!Number.isInteger(maxN) || maxN < 1) local["scaling.max_instances"] = t("scaling.maxInvalid");
    if (!local["scaling.min_instances"] && !local["scaling.max_instances"] && minN > maxN) {
      local["scaling.max_instances"] = t("scaling.maxBelowMin");
    }
    setFields(local);
    setErrors([]);
    if (Object.keys(local).length > 0) return;

    try {
      await patch.mutateAsync({
        etag: app.etag,
        body: { scaling: { min_instances: minN, max_instances: maxN } },
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
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="scaling-min">{t("scaling.min")}</Label>
            <Input
              id="scaling-min"
              inputMode="numeric"
              value={min}
              onChange={(e) => setMin(e.target.value)}
              aria-invalid={Boolean(fields["scaling.min_instances"])}
              aria-describedby="scaling-min-error"
            />
            <FieldError id="scaling-min-error" message={fields["scaling.min_instances"]} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="scaling-max">{t("scaling.max")}</Label>
            <Input
              id="scaling-max"
              inputMode="numeric"
              value={max}
              onChange={(e) => setMax(e.target.value)}
              aria-invalid={Boolean(fields["scaling.max_instances"])}
              aria-describedby="scaling-max-error"
            />
            <FieldError id="scaling-max-error" message={fields["scaling.max_instances"]} />
          </div>
        </div>
        <FormAlert messages={errors} />
        <p className="text-sm text-muted">{t("replaceNote")}</p>
        <div>
          <SaveButton disabled={patch.isPending}>
            {t("scaling.save")}
          </SaveButton>
        </div>
      </form>
    </Section>
  );
}
