import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type AppDetail, usePatchApp } from "./api";
import { flattenLimits, formatLimit } from "./limit-format";
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
        <div className="flex flex-col gap-2 rounded-sm border border-line p-3">
          <p className="text-[13px] font-medium text-text">Requested</p>
          <LimitList values={app.limits.requested ?? {}} empty="Nothing requested." />
        </div>
        <div className="flex flex-col gap-2 rounded-sm border border-line p-3">
          <p className="text-[13px] font-medium text-text">Effective</p>
          <LimitList values={app.limits.effective} empty="No limits apply." />
          <p className="text-sm text-muted">
            Source: <span className="text-text">{SOURCE_LABEL[app.limits.source]}</span>
          </p>
        </div>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-label="Limits settings">
        <div className="flex flex-col gap-1">
          <Label htmlFor="limits-profile">Profile</Label>
          <Input id="limits-profile" value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="e.g. small…" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="limits-json">Requested limits (JSON)</Label>
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

// LimitList renders limits as a key/value list with units, so a number reads as "1 MiB" or "30 s".
function LimitList({ values, empty }: { values: Record<string, unknown>; empty: string }) {
  const rows = flattenLimits(values);
  if (rows.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([key, value]) => {
        const { label, value: text } = formatLimit(key, value);
        return (
          <div key={key} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="text-right font-mono text-xs text-text tabular-nums">{text}</dd>
          </div>
        );
      })}
    </dl>
  );
}
