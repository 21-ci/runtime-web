import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type AppAccess, type AppDetail, useCreateInvokeToken, usePatchApp } from "./api";
import { FormAlert, Section, fieldErrorsOf, SaveButton, unmappedErrors } from "./shared";

const MODES: { value: AppAccess; label: string; help: string }[] = [
  { value: "public", label: "Public", help: "Anyone with the URL can call this app." },
  { value: "key", label: "Key", help: "Callers must send an invoke token." },
  { value: "internal", label: "Internal", help: "Only other apps in this org can call it." },
];

// AccessSection sets who may call the app. Key mode needs an invoke token, so it offers to mint one.
export function AccessSection({ org, app }: { org: string; app: AppDetail }) {
  const [access, setAccess] = useState<AppAccess>(app.access);
  const [errors, setErrors] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const patch = usePatchApp(org, app.slug);
  const mint = useCreateInvokeToken(org, app.slug);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrors([]);
    try {
      await patch.mutateAsync({ etag: app.etag, body: { access } });
      toast.success("Access saved");
    } catch (err) {
      setErrors(unmappedErrors(fieldErrorsOf(err), []));
    }
  }

  async function onMint() {
    try {
      const created = await mint.mutateAsync();
      setSecret(created.secret);
    } catch {
      toast.error("Could not create the invoke token. Try again.");
    }
  }

  const help = MODES.find((m) => m.value === access)?.help;

  return (
    <Section id="access" title="Access" description="Who can call this app over HTTP.">
      <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-label="Access settings">
        <div className="flex flex-col gap-1">
          <Label htmlFor="access-mode">Access</Label>
          <Select value={access} onValueChange={(v) => setAccess(v as AppAccess)}>
            <SelectTrigger id="access-mode" className="h-[38px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted">{help}</p>
        </div>

        {access === "key" ? (
          <div className="flex flex-col gap-2 rounded-[4px] border border-line p-3">
            <p className="text-sm text-text">Key mode needs an invoke token. Create one and give it to the caller.</p>
            {secret ? (
              <div className="flex flex-col gap-1">
                <code className="break-all rounded bg-panel-2 p-2 text-sm">{secret}</code>
                <p className="text-sm text-muted">Shown once. Copy it now.</p>
              </div>
            ) : (
              <div>
                <Button type="button" variant="secondary" onClick={onMint} disabled={mint.isPending}>
                  Create invoke token
                </Button>
              </div>
            )}
          </div>
        ) : null}

        <FormAlert messages={errors} />
        <div>
          <SaveButton disabled={patch.isPending}>
            Save access
          </SaveButton>
        </div>
      </form>
    </Section>
  );
}
