import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type AppDetail, usePatchApp } from "./api";
import { FieldError, FormAlert, REPLACE_NOTE, Section, fieldErrorsOf, SaveButton, unmappedErrors } from "./shared";

const SOURCE_LABEL: Record<AppDetail["limits"]["source"], string> = {
  plan: "the org plan",
  profile: "the runtime profile",
  service: "this app's own requested limits",
};

// LimitsSection shows what the app asked for next to what it actually gets, and where that comes
// from. The requested block is editable JSON; the effective block is read-only.
export function LimitsSection({ org, app }: { org: string; app: AppDetail }) {
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
      setFieldError("Requested limits must be valid JSON (an object).");
      return;
    }
    setFieldError(undefined);
    setErrors([]);
    try {
      await patch.mutateAsync({
        etag: app.etag,
        body: { profile: profile.trim() === "" ? null : profile.trim(), limits: parsed },
      });
      toast.success("Limits saved");
    } catch (err) {
      const server = fieldErrorsOf(err);
      setFieldError(server.limits);
      setErrors(unmappedErrors(server, ["limits"]));
    }
  }

  return (
    <Section id="limits" title="Limits" description="What this app asked for and what it gets.">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1 rounded-[4px] border border-line p-3">
          <p className="text-sm font-medium text-text">Requested</p>
          <pre className="overflow-x-auto text-xs text-muted">
            {JSON.stringify(app.limits.requested ?? {}, null, 2)}
          </pre>
        </div>
        <div className="flex flex-col gap-1 rounded-[4px] border border-line p-3">
          <p className="text-sm font-medium text-text">Effective</p>
          <pre className="overflow-x-auto text-xs text-text">{JSON.stringify(app.limits.effective, null, 2)}</pre>
          <p className="text-sm text-muted">
            Source: <span className="text-text">{SOURCE_LABEL[app.limits.source]}</span>
          </p>
        </div>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-label="Limits settings">
        <div className="flex flex-col gap-1">
          <Label htmlFor="limits-profile">Profile</Label>
          <Input id="limits-profile" value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="None" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="limits-json">Requested limits (JSON)</Label>
          <textarea
            id="limits-json"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            aria-describedby="limits-error"
            className="rounded-[4px] border border-line-strong bg-surface p-2 font-mono text-sm text-text focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus"
          />
          <FieldError id="limits-error" message={fieldError} />
        </div>
        <FormAlert messages={errors} />
        <p className="text-sm text-muted">{REPLACE_NOTE}</p>
        <div>
          <SaveButton disabled={patch.isPending}>
            Save limits
          </SaveButton>
        </div>
      </form>
    </Section>
  );
}
