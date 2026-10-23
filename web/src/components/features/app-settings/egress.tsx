import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Label } from "@/components/ui/label";
import { type AppDetail, usePatchApp } from "./api";
import { FieldError, FormAlert, REPLACE_NOTE, Section, fieldErrorsOf, SaveButton, unmappedErrors } from "./shared";

// EgressSection edits the outbound policy block as JSON. The runtime owns its shape, so the form
// checks only that the text is a JSON object and shows server field errors next to the box.
export function EgressSection({ org, app }: { org: string; app: AppDetail }) {
  const [text, setText] = useState(JSON.stringify(app.egress ?? {}, null, 2));
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
      setFieldError("Egress must be valid JSON (an object).");
      return;
    }
    setFieldError(undefined);
    setErrors([]);
    try {
      await patch.mutateAsync({ etag: app.etag, body: { egress: parsed } });
      toast.success("Egress saved");
    } catch (err) {
      const server = fieldErrorsOf(err);
      setFieldError(server.egress);
      setErrors(unmappedErrors(server, ["egress"]));
    }
  }

  return (
    <Section id="egress" title="Egress" description="Outbound traffic policy for this app.">
      <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-label="Egress settings">
        <div className="flex flex-col gap-1">
          <Label htmlFor="egress-json">Egress JSON</Label>
          <textarea
            id="egress-json"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            aria-describedby="egress-error"
            className="rounded-[4px] border border-line-strong bg-surface p-2 font-mono text-sm text-text focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus"
          />
          <FieldError id="egress-error" message={fieldError} />
        </div>
        <FormAlert messages={errors} />
        <p className="text-sm text-muted">{REPLACE_NOTE}</p>
        <div>
          <SaveButton disabled={patch.isPending}>
            Save egress
          </SaveButton>
        </div>
      </form>
    </Section>
  );
}
