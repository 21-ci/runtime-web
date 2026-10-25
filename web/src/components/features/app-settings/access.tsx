import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
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

const MODES = [
  { value: "public", labelKey: "access.modes.public", helpKey: "access.help.public" },
  { value: "key", labelKey: "access.modes.key", helpKey: "access.help.key" },
  { value: "internal", labelKey: "access.modes.internal", helpKey: "access.help.internal" },
] as const satisfies readonly { value: AppAccess; labelKey: string; helpKey: string }[];

// AccessSection sets who may call the app. Key mode needs an invoke token, so it offers to mint one.
export function AccessSection({ org, app }: { org: string; app: AppDetail }) {
  const { t } = useTranslation(["app-settings", "common"]);
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
      toast.success(t("access.saved"));
    } catch (err) {
      setErrors(unmappedErrors(fieldErrorsOf(err), []));
    }
  }

  async function onMint() {
    try {
      const created = await mint.mutateAsync();
      setSecret(created.secret);
    } catch {
      toast.error(t("access.tokenFailed"));
    }
  }

  const help = MODES.find((m) => m.value === access)?.helpKey;

  return (
    <Section id="access" title={t("access.title")} description={t("access.description")}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-label={t("access.formLabel")}>
        <div className="flex flex-col gap-1">
          <Label htmlFor="access-mode">{t("access.label")}</Label>
          <Select value={access} onValueChange={(v) => setAccess(v as AppAccess)}>
            <SelectTrigger id="access-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {t(m.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted">{help ? t(help) : null}</p>
        </div>

        {access === "key" ? (
          <div className="flex flex-col gap-2 rounded-sm border border-line p-3">
            <p className="text-sm text-text">{t("access.keyHint")}</p>
            {secret ? (
              <div className="flex flex-col gap-1">
                <code className="break-all rounded bg-panel-2 p-2 text-sm">{secret}</code>
                <p className="text-sm text-muted">{t("access.shownOnce")}</p>
              </div>
            ) : (
              <div>
                <Button type="button" variant="secondary" onClick={onMint} disabled={mint.isPending}>
                  {t("access.createToken")}
                </Button>
              </div>
            )}
          </div>
        ) : null}

        <FormAlert messages={errors} />
        <div>
          <SaveButton disabled={patch.isPending}>
            {t("access.save")}
          </SaveButton>
        </div>
      </form>
    </Section>
  );
}
