import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type AppDetail, usePatchApp } from "./api";
import { FieldError, FormAlert, REPLACE_NOTE, Section, fieldErrorsOf, SaveButton, unmappedErrors } from "./shared";

const SHOWN = ["scaling.min_instances", "scaling.max_instances"];

// ScalingSection edits the instance range. Server 422 paths map onto the min and max inputs.
export function ScalingSection({ org, app }: { org: string; app: AppDetail }) {
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
    if (!Number.isInteger(minN) || minN < 0) local["scaling.min_instances"] = "Use a whole number, 0 or more.";
    if (!Number.isInteger(maxN) || maxN < 1) local["scaling.max_instances"] = "Use a whole number, 1 or more.";
    if (!local["scaling.min_instances"] && !local["scaling.max_instances"] && minN > maxN) {
      local["scaling.max_instances"] = "Max must be at least min.";
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
      toast.success("Scaling saved");
    } catch (err) {
      const server = fieldErrorsOf(err);
      setFields(server);
      setErrors(unmappedErrors(server, SHOWN));
    }
  }

  return (
    <Section id="scaling" title="Scaling" description="How many instances run, from idle to peak.">
      <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-label="Scaling settings">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="scaling-min">Min instances</Label>
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
            <Label htmlFor="scaling-max">Max instances</Label>
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
        <p className="text-sm text-muted">{REPLACE_NOTE}</p>
        <div>
          <SaveButton disabled={patch.isPending}>
            Save scaling
          </SaveButton>
        </div>
      </form>
    </Section>
  );
}
